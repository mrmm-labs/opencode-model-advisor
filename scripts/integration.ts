/**
 * Loads the BUILT plugin into an isolated OpenCode and drives one subagent
 * dispatch through it.
 *
 * Nothing of the user's OpenCode is touched: XDG_* and HOME point at a temp
 * dir, the plugin directory lives there, and the "model provider" is a local
 * HTTP server that replays canned Anthropic SSE streams. The first request
 * answers with a `subagent` tool call, so the router runs for real.
 *
 * Run with: pnpm test:integration
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const RUN_TIMEOUT_MS = 90_000

type Seen = { model: string; kind: string; text: string }
type Scenario = {
  name: string
  config: object
  /** The dispatch prompt the replayed parent sends to the subagent. */
  dispatch: string
  /** The judge's replayed answer, when the scenario uses the judge. */
  judge?: string
  /** How many times the plugin is installed, to see a dispatch counted once. */
  copies?: number
}

const fail = (message: string): never => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

const sse = (events: Array<[string, object]>) =>
  events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("")

function stream(model: string, blocks: object[], stop: string, input = 20_000) {
  const out: Array<[string, object]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_replay",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input, output_tokens: 1 },
        },
      },
    ],
  ]
  blocks.forEach((block, index) => {
    const b = block as { type: string; text?: string; input?: object }
    if (b.type === "text") {
      out.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      ])
      out.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: b.text },
        },
      ])
    } else {
      out.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { ...b, input: {} },
        },
      ])
      out.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(b.input),
          },
        },
      ])
    }
    out.push(["content_block_stop", { type: "content_block_stop", index }])
  })
  out.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 40 },
    },
  ])
  out.push(["message_stop", { type: "message_stop" }])
  return sse(out)
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => done(data))
  })

/** The text of the last user message, and whether it is a tool result. */
function lastUser(body: {
  messages?: Array<{ role: string; content: unknown }>
}) {
  const m = (body.messages ?? []).toReversed().find((x) => x.role === "user")
  const parts = Array.isArray(m?.content)
    ? (m.content as Array<{ type: string; text?: string }>)
    : []
  return {
    toolResult: parts.some((p) => p.type === "tool_result"),
    text:
      typeof m?.content === "string"
        ? m.content
        : parts.map((p) => p.text ?? "").join("\n"),
  }
}

async function replayProvider(scenario: Scenario, seen: Seen[]) {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req)
    if (!req.url?.includes("/messages")) {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw)
    const user = lastUser(body)
    const tools = (body.tools ?? []).map((t: { name: string }) => t.name)
    let kind = "chat"
    let reply: string
    if (user.text.includes("You route one coding-agent task")) {
      kind = "judge"
      reply = stream(
        body.model,
        [
          {
            type: "text",
            text: scenario.judge ?? '{"tier":"sonnet","reason":"x"}',
          },
        ],
        "end_turn",
      )
    } else if (
      !user.toolResult &&
      user.text.includes("DISPATCH-ME") &&
      tools.includes("subagent")
    ) {
      kind = "parent-dispatch"
      reply = stream(
        body.model,
        [
          {
            type: "tool_use",
            id: "toolu_replay",
            name: "subagent",
            input: {
              agent: "smoke-worker",
              description: "replayed work",
              prompt: scenario.dispatch,
            },
          },
        ],
        "tool_use",
      )
    } else if (user.toolResult) {
      kind = "parent-final"
      reply = stream(
        body.model,
        [{ type: "text", text: "all done" }],
        "end_turn",
      )
    } else if (user.text.includes("child task")) {
      kind = "child"
      reply = stream(
        body.model,
        [{ type: "text", text: "child finished" }],
        "end_turn",
        50_000,
      )
    } else {
      kind = "other"
      reply = stream(body.model, [{ type: "text", text: "ok" }], "end_turn")
    }
    seen.push({ model: body.model, kind, text: user.text })
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(reply)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return { server, port: (server.address() as AddressInfo).port }
}

/** A tiny OTLP receiver that keeps what it was sent. */
async function otlpSink() {
  const traces: any[] = []
  const metrics: any[] = []
  // ADVISOR_OTLP_ENDPOINT: also forward what the plugin sends to a real collector.
  const forward = process.env.ADVISOR_OTLP_ENDPOINT?.replace(/\/+$/, "")
  const server = createServer(async (req, res) => {
    const raw = (await readBody(req)) || "{}"
    if (forward) {
      await fetch(`${forward}${req.url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }).catch(() => undefined)
    }
    const body = JSON.parse(raw)
    if (req.url?.endsWith("/v1/traces")) traces.push(body)
    if (req.url?.endsWith("/v1/metrics")) metrics.push(body)
    res.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return {
    server,
    traces,
    metrics,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}

const attr = (span: any, key: string) => {
  const v = span.attributes?.find((a: any) => a.key === key)?.value
  return v
    ? (v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue)
    : undefined
}

const model = (id: string) => ({
  modelID: id,
  limit: { context: 200000, output: 32000 },
})

async function runScenario(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "advisor-it-"))
  const dirs = Object.fromEntries(
    ["config", "data", "state", "cache", "work", "home"].map((d) => [
      d,
      join(root, d),
    ]),
  )
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

  const seen: Seen[] = []
  const { server, port } = await replayProvider(scenario, seen)
  const sink = await otlpSink()

  for (let n = 0; n < (scenario.copies ?? 1); n++) {
    const plugin = join(
      dirs.config,
      "opencode",
      "plugins",
      n === 0 ? "model-advisor" : `model-advisor-${n + 1}`,
    )
    mkdirSync(plugin, { recursive: true })
    // OpenCode loads one plugin per id, so a second copy needs its own.
    writeFileSync(
      join(plugin, "index.js"),
      n === 0
        ? readFileSync(join(repo, "index.js"))
        : `import plugin from "./dist/index.js"\nexport default { ...plugin, id: "model-advisor-${n + 1}" }\n`,
    )
    symlinkSync(join(repo, "dist"), join(plugin, "dist"))
  }

  writeFileSync(
    join(dirs.config, "opencode", "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: {
        advreplay: {
          name: "Replay",
          package: "@opencode/ai/providers/anthropic",
          settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x" },
          models: {
            "claude-haiku-5-5": model("claude-haiku-5-5"),
            "claude-sonnet-5-5": model("claude-sonnet-5-5"),
            "claude-opus-5-5": model("claude-opus-5-5"),
          },
        },
      },
      agents: {
        "smoke-worker": { mode: "subagent", description: "Replay worker" },
      },
    }),
  )
  const advisorConfig = join(root, "model-advisor.jsonc")
  writeFileSync(
    advisorConfig,
    JSON.stringify({
      provider: "advreplay",
      otel: { endpoint: sink.url },
      ...scenario.config,
    }),
  )
  const logFile = join(root, "advisor.log")
  const decisionsFile = join(root, "decisions.jsonl")

  const env = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    OPENCODE_MODEL_ADVISOR_CONFIG: advisorConfig,
    OPENCODE_MODEL_ADVISOR_LOG: logFile,
    OPENCODE_MODEL_ADVISOR_DECISIONS: decisionsFile,
  }
  const child = spawn(
    "opencode",
    [
      "run",
      "--standalone",
      "--auto",
      "--model",
      "advreplay/claude-sonnet-5-5",
      "--agent",
      "build",
      "DISPATCH-ME please",
    ],
    { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout.on("data", (c) => (output += c))
  child.stderr.on("data", (c) => (output += c))
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(
      () => (child.kill("SIGKILL"), done(null)),
      RUN_TIMEOUT_MS,
    )
    child.on("exit", (c) => (clearTimeout(timer), done(c)))
  })
  await new Promise((r) => setTimeout(r, 500))

  const log = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const decisions = existsSync(decisionsFile)
    ? readFileSync(decisionsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  server.close()
  sink.server.close()
  const result = {
    code,
    output,
    seen,
    log,
    decisions,
    traces: sink.traces,
    metrics: sink.metrics,
    root,
  }
  return result
}

function spansOf(traces: any[]): any[] {
  return traces.flatMap((t) =>
    t.resourceSpans.flatMap((r: any) =>
      r.scopeSpans.flatMap((s: any) => s.spans),
    ),
  )
}

function metricsOf(metrics: any[]): any[] {
  return metrics.flatMap((m) =>
    m.resourceMetrics.flatMap((r: any) =>
      r.scopeMetrics.flatMap((s: any) => s.metrics),
    ),
  )
}

const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`)
  if (!ok) {
    if (detail !== undefined)
      console.log(
        typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
      )
    process.exitCode = 1
  }
}

const rules = [
  { id: "workers-on-haiku", when: { agent: "smoke-worker" }, tier: "haiku" },
]
const dispatch =
  "child task: summarise the repo\n[[route: task=smoke-1 files=20]]\nplease be quick"

async function main() {
  if (spawnSync("opencode", ["--version"]).status !== 0)
    fail("`opencode` not found on PATH")
  if (!existsSync(join(repo, "dist", "index.js")))
    fail("run `pnpm run build` first")

  const only = process.argv[2]
  const scenarios: Scenario[] = [
    { name: "shadow", config: { mode: "shadow", rules }, dispatch },
    { name: "enforce", config: { mode: "enforce", rules }, dispatch },
    {
      name: "twice",
      config: { mode: "shadow", rules },
      dispatch,
      copies: 2,
    },
    {
      name: "judge",
      config: { mode: "shadow", judge: { enabled: true, timeoutMs: 20000 } },
      dispatch,
      judge: '{"tier":"opus","reason":"smoke judge picked opus"}',
    },
  ].filter((s) => !only || s.name === only)

  for (const s of scenarios) {
    console.log(`\n── ${s.name} ─────────────────────────────`)
    const r = await runScenario(s)
    const events = r.log.map((l) => l.event)
    console.log(
      `opencode exit=${r.code}; replay saw: ${r.seen.map((x) => `${x.kind}@${x.model}`).join(", ")}`,
    )
    console.log(`plugin log: ${events.join(", ")}`)
    const loaded = r.log.find((l) => l.event === "plugin_loaded")
    check(!!loaded, "plugin loaded", r.output.slice(-1500))
    if (loaded) console.log(`  ${JSON.stringify(loaded)}`)

    const mine = r.decisions.filter((x: any) => x.kind === "decision")
    check(
      mine.length === 1 && mine[0].agent === "smoke-worker",
      `decisions.jsonl: one decision line for the one dispatch (${s.copies ?? 1} plugin copies)`,
      r.decisions,
    )
    check(
      r.decisions.filter((x: any) => x.kind === "link").length === 1 &&
        r.decisions.find((x: any) => x.kind === "link")?.decision ===
          mine[0]?.id,
      "decisions.jsonl: the child session is linked to the decision",
      r.decisions,
    )
    if (s.copies) {
      const loads = r.log.filter((l) => l.event === "plugin_loaded").length
      check(loads >= s.copies, `plugin loaded ${loads} times`, r.log)
    }
    const child = r.seen.find((x) => x.kind === "child")
    check(!!child, "subagent dispatched and answered", r.output.slice(-1500))
    const span = spansOf(r.traces).find((x) => x.name === "route smoke-worker")
    check(!!span, "span `route smoke-worker` exported", r.log)
    if (span) {
      const a = Object.fromEntries(
        span.attributes.map((x: any) => [x.key, attr(span, x.key)]),
      )
      console.log(`  span: ${JSON.stringify(a)}`)
      console.log(`  traceId=${span.traceId}`)
    }
    const names = metricsOf(r.metrics).map((m) => m.name)
    check(
      names.includes("model_advisor.decisions"),
      "metric model_advisor.decisions exported",
      names,
    )

    if (span) {
      const sessionId = attr(span, "session.id")
      check(
        span.traceId ===
          createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
        "span trace id = sha256(root session id)[:32], as in opencode-claude-accounts",
        { sessionId, traceId: span.traceId },
      )
    }
    if (s.name === "shadow") {
      const saving = metricsOf(r.metrics).find(
        (m) => m.name === "model_advisor.shadow.estimated_saving_usd",
      )
      const dp = saving?.sum.dataPoints[0]
      console.log(`  saving datapoint: ${JSON.stringify(dp)}`)
      // child step: 50000 input + 40 output tokens at sonnet list price, would-be haiku
      const expected = ((50_000 * 3 + 40 * 15) / 1e6) * (1 - 1 / 3)
      check(
        Math.abs((dp?.asDouble ?? 0) - expected) < 1e-6,
        `shadow: saving = ${expected.toFixed(6)} USD`,
        dp,
      )
      check(
        child?.model === "claude-sonnet-5-5",
        "shadow: child kept the caller's model",
        child,
      )
      check(
        attr(span, "route.would") === "claude-haiku-5-5",
        "shadow: would = haiku",
        span,
      )
      check(
        child?.text.includes("[[route:") === true,
        "shadow: prompt left untouched",
      )
      check(
        names.includes("model_advisor.shadow.estimated_saving_usd"),
        "shadow: saving estimate emitted",
        names,
      )
    }
    if (s.name === "enforce") {
      check(
        child?.model === "claude-haiku-5-5",
        "enforce: child ran on haiku",
        child,
      )
      check(
        child?.text.includes("[[route:") === false,
        "enforce: hint line stripped from the prompt",
        child?.text,
      )
      check(
        attr(span, "route.model") === "claude-haiku-5-5",
        "enforce: span route.model = haiku",
        span,
      )
    }
    if (s.name === "judge") {
      check(
        r.seen.some((x) => x.kind === "judge"),
        "judge: one-shot call reached the provider",
        r.seen,
      )
      check(
        attr(span, "route.source") === "judge" &&
          attr(span, "route.would") === "claude-opus-5-5",
        "judge: decision came from the judge",
        span,
      )
    }
    rmSync(r.root, { recursive: true, force: true })
  }
}

await main()
