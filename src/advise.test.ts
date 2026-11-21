import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  ADVISOR_MARK,
  advisorImpl,
  BETA,
  createAdvise,
  estimateTokens,
  rankOf,
  SYSTEM_LINE,
  TOOL_SYSTEM_LINE,
  toolActive,
  TOOL_TYPE,
  withoutAdvisor,
  type HookContext,
  type HookRequest,
} from "./advise.ts"
import { buildConfig, type Config } from "./config.ts"
import type { AdvisorRecord } from "./decisions.ts"
import { judgePrompt } from "./judge.ts"
import type { Span, Telemetry } from "./otel.ts"
import { defaultRoutingV2, type RoutingV2Config } from "./route-v2.ts"
import type { UsageRow } from "./usage.ts"

const SSE = readFileSync(
  new URL("./fixtures/advisor-response.sse", import.meta.url),
  "utf8",
)

function setup(config: object = {}, v2?: Partial<RoutingV2Config>) {
  const cfg = buildConfig({
    mode: "enforce",
    advisor: { enabled: true, alertSteps: 2 },
    ...config,
  }).config
  if (v2) cfg.v2 = { ...defaultRoutingV2(), enabled: true, ...v2 }
  const records: AdvisorRecord[] = []
  const counts: Array<{
    name: string
    attrs: Record<string, unknown>
    by: number
  }> = []
  const spans: Span[] = []
  const rows: UsageRow[] = []
  const telemetry = {
    span: (s: Span) => spans.push(s),
    count: (name: string, attrs: Record<string, unknown>, by = 1) =>
      counts.push({ name, attrs, by }),
    record() {},
    dispose: async () => {},
  } as unknown as Telemetry
  const advise = createAdvise({
    config: () => cfg,
    telemetry,
    record: (r) => records.push(r),
    usage: { add: (row) => rows.push(row) },
    root: async (id) => `root-${id}`,
    now: () => 1_700_000_000_000,
  })
  const named = (name: string) => counts.filter((c) => c.name === name)
  return { advise, records, rows, counts, spans, named }
}

const request = (
  over: Partial<HookRequest> = {},
  body: object = {},
): HookRequest => ({
  url: "https://api.anthropic.com/v1/messages",
  body: {
    model: "claude-sonnet-5-5",
    system: [
      { type: "text", text: "billing header" },
      { type: "text", text: "You are a worker." },
    ],
    messages: [{ role: "user", content: "do it" }],
    tools: [{ name: "bash", input_schema: { type: "object" } }],
    ...body,
  },
  headers: new Headers({ "anthropic-beta": "oauth-2025-04-20" }),
  model: "claude-sonnet-5-5",
  agent: "builder",
  sessionID: "ses_1",
  ...over,
})

describe("advisor policy", () => {
  it("attaches the tool, the beta header and one system line", async () => {
    const { advise } = setup()
    const req = request()
    await advise.before(req)
    const tools = req.body.tools as any[]
    assert.deepEqual(tools.at(-1), {
      type: TOOL_TYPE,
      name: "advisor",
      model: "claude-opus-5-5",
      max_uses: 2,
    })
    assert.equal(tools.length, 2)
    assert.equal(req.headers.get("anthropic-beta"), `oauth-2025-04-20,${BETA}`)
    const system = req.body.system as any[]
    assert.equal(system[0].text, "billing header")
    assert.equal(system[1].text, `You are a worker.\n\n${SYSTEM_LINE}`)
  })

  it("is idempotent and keeps the beta list free of duplicates", async () => {
    const { advise } = setup()
    const req = request()
    req.headers.set("anthropic-beta", `${BETA}, oauth-2025-04-20`)
    await advise.before(req)
    await advise.before(req)
    assert.equal(
      (req.body.tools as any[]).filter((t) => t.type === TOOL_TYPE).length,
      1,
    )
    assert.equal(req.headers.get("anthropic-beta"), `oauth-2025-04-20,${BETA}`)
    assert.equal(JSON.stringify(req.body).split(SYSTEM_LINE).length, 2)
  })

  it("creates tools and handles a string or missing system prompt", async () => {
    const { advise } = setup()
    const a = request({}, { tools: undefined, system: "Be brief." })
    await advise.before(a)
    assert.equal((a.body.tools as any[]).length, 1)
    assert.equal(a.body.system, `Be brief.\n\n${SYSTEM_LINE}`)
    const b = request({}, { system: undefined })
    await advise.before(b)
    assert.equal((b.body.system as any[])[0].text, SYSTEM_LINE)
  })

  it("uses the configured advisor model and max uses", async () => {
    const { advise } = setup({
      advisor: { enabled: true, model: "claude-opus-5-5", maxUses: 5 },
    })
    const req = request()
    await advise.before(req)
    assert.equal((req.body.tools as any[]).at(-1).max_uses, 5)
  })

  const skipped: Array<[string, Partial<HookRequest>, object?, object?]> = [
    ["advisor disabled", {}, undefined, { advisor: { enabled: false } }],
    ["an orchestrator", { agent: "build" }],
    ["no agent", { agent: undefined }],
    ["an executor at the advisor's own tier", { model: "claude-opus-5-5" }],
    ["an unknown model", { model: "gpt-9" }],
    [
      "a context over the limit",
      {},
      { messages: [{ role: "user", content: "x".repeat(4000) }] },
      { advisor: { enabled: true, maxContextTokens: 500 } },
    ],
    [
      "a judge call",
      {},
      {
        messages: [
          {
            role: "user",
            content: judgePrompt(buildConfig({}).config, "builder", "t"),
          },
        ],
      },
    ],
  ]
  for (const [label, over, body, config] of skipped) {
    it(`does not attach for ${label}`, async () => {
      const { advise } = setup(config)
      const req = request(over, body)
      const before = structuredClone(req.body)
      await advise.before(req)
      assert.deepEqual(req.body, before)
      assert.equal(req.headers.get("anthropic-beta"), "oauth-2025-04-20")
    })
  }

  it("attaches for a haiku executor as well", async () => {
    const { advise } = setup()
    const req = request({ model: "claude-haiku-5-5" })
    await advise.before(req)
    assert.ok(JSON.stringify(req.body).includes(TOOL_TYPE))
  })

  it("in shadow mode changes nothing and records a would-attach once per session", async () => {
    const { advise, records, named } = setup({ mode: "shadow" })
    const req = request()
    const before = structuredClone(req.body)
    await advise.before(req)
    await advise.before(request())
    assert.deepEqual(req.body, before)
    assert.equal(named("model_advisor.advisor.would_attach").length, 1)
    assert.equal(records.length, 1)
    assert.equal((records[0] as any).would, true)
  })

  it("estimates context as characters over four", () => {
    assert.equal(estimateTokens({ a: "x".repeat(392) }), 100)
  })

  it("ranks models by ladder position", () => {
    const { config } = buildConfig({})
    assert.equal(rankOf("anthropic/claude-sonnet-5-5", config), 1)
    assert.equal(rankOf("claude-opus-5-5", config), 2)
    assert.equal(rankOf("gpt-9", config), undefined)
  })
})

const sseResponse = (text = SSE, status = 200, type = "text/event-stream") =>
  new Response(text, { status, headers: { "content-type": type } })

async function attached(advise: ReturnType<typeof setup>["advise"]) {
  const req = request()
  await advise.before(req)
  const ctx: HookContext = {
    ...req,
    resend: async () => new Response("resent"),
  }
  return { req, ctx }
}

describe("advisor response", () => {
  it("returns responses of requests with no advisor untouched", async () => {
    const { advise } = setup()
    const res = sseResponse()
    const ctx = { ...request(), resend: async () => res }
    assert.equal(await advise.response(res, ctx), res)
  })

  it("filters the stream and records usage, cost, a span and metrics", async () => {
    const { advise, records, rows, spans, named } = setup()
    const { ctx } = await attached(advise)
    const out = await advise.response(sseResponse(), ctx)
    const text = await out.text()
    assert.ok(!text.includes("advisor_tool_result"))
    assert.ok(!text.includes('"name":"advisor"'))
    assert.ok(text.includes("text_delta"))
    await new Promise((r) => setTimeout(r, 5))

    const cost = (29025 * 5 + 1763 * 25) / 1e6
    assert.equal(spans.length, 1)
    assert.equal(spans[0].name, "advisor builder")
    assert.equal(spans[0].traceSession, "root-ses_1")
    assert.equal(spans[0].attrs["advisor.calls"], 1)
    assert.equal(spans[0].attrs["advisor.input_tokens"], 29025)
    assert.equal(spans[0].attrs["advisor.output_tokens"], 1763)
    assert.ok(
      Math.abs((spans[0].attrs["advisor.cost_usd"] as number) - cost) < 1e-9,
    )
    assert.equal(named("model_advisor.advisor.calls")[0].by, 1)
    assert.deepEqual(
      named("model_advisor.advisor.tokens").map((c) => [c.attrs.kind, c.by]),
      [
        ["input", 29025],
        ["output", 1763],
      ],
    )
    assert.ok(
      Math.abs(named("model_advisor.advisor.cost_usd")[0].by - cost) < 1e-9,
    )
    const advice = records.find((r) => r.kind === "advice") as any
    assert.equal(advice.calls, 1)
    assert.equal(advice.session, "ses_1")
    assert.equal(rows.length, 1)
    assert.deepEqual(
      { ...rows[0], cost: undefined },
      {
        v: 1,
        day: rows[0].day,
        provider: "anthropic",
        model: "claude-opus-5-5",
        agent: "builder",
        role: "advisor",
        requests: 1,
        input: 29025,
        output: 1763,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: undefined,
        sessions: ["ses_1"],
      },
    )
    assert.ok(Math.abs(rows[0].cost - cost) < 1e-9)
  })

  it("writes one usage row per advisor call and leaves the executor's tokens out", async () => {
    const { advise, rows, named } = setup()
    const { ctx } = await attached(advise)
    const body = {
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        iterations: [
          { type: "message", input_tokens: 5, output_tokens: 6 },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            input_tokens: 1000,
            output_tokens: 100,
          },
          {
            type: "advisor_message",
            model: "claude-sonnet-5-5",
            input_tokens: 2000,
            output_tokens: 200,
            cache_read_input_tokens: 400,
          },
        ],
      },
    }
    const out = await advise.response(
      sseResponse(JSON.stringify(body), 200, "application/json"),
      ctx,
    )
    const parsed = await out.json()
    assert.equal(parsed.usage.input_tokens, 5)
    assert.deepEqual(
      rows.map((r) => [r.role, r.model, r.input, r.output, r.cacheRead]),
      [
        ["advisor", "claude-opus-5-5", 1000, 100, 0],
        ["advisor", "claude-sonnet-5-5", 2000, 200, 400],
      ],
    )
    assert.ok(Math.abs(rows[0].cost - (1000 * 5 + 100 * 25) / 1e6) < 1e-9)
    assert.ok(
      Math.abs(rows[1].cost - (2000 * 3 + 200 * 15 + 400 * 0.3) / 1e6) < 1e-9,
    )
    assert.equal(named("model_advisor.advisor.calls")[0].by, 2)
  })

  it("records nothing when the advisor was attached but never called", async () => {
    const { advise, spans } = setup()
    const { ctx } = await attached(advise)
    const plain = SSE.slice(0, SSE.indexOf("event: content_block_start"))
    await (await advise.response(sseResponse(plain), ctx)).text()
    assert.equal(spans.length, 0)
  })

  it("filters a JSON response", async () => {
    const { advise, spans } = setup()
    const { ctx } = await attached(advise)
    const body = {
      content: [
        { type: "server_tool_use", name: "advisor", id: "s" },
        { type: "advisor_tool_result", tool_use_id: "s", content: {} },
        { type: "text", text: "ok" },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        iterations: [
          { type: "message", input_tokens: 5, output_tokens: 6 },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            input_tokens: 1000,
            output_tokens: 100,
          },
        ],
      },
    }
    const out = await advise.response(
      sseResponse(JSON.stringify(body), 200, "application/json"),
      ctx,
    )
    const parsed = await out.json()
    assert.deepEqual(parsed.content, [{ type: "text", text: "ok" }])
    assert.equal(parsed.usage.iterations.length, 1)
    assert.equal(spans[0].attrs["advisor.calls"], 1)
  })

  it("on a 400 that names the advisor, resends once without it and alerts", async () => {
    const { advise, records, named } = setup()
    const { req, ctx } = await attached(advise)
    let resent: any
    ctx.resend = async (body) => ((resent = body), new Response("second"))
    const refusal = sseResponse(
      JSON.stringify({
        error: { message: "advisor_20260301 is not supported for this model" },
      }),
      400,
      "application/json",
    )
    const out = await advise.response(refusal, ctx)
    assert.equal(await out.text(), "second")
    assert.ok(!JSON.stringify(resent).includes(TOOL_TYPE))
    assert.ok(!JSON.stringify(resent).includes(SYSTEM_LINE))
    assert.equal(resent.tools.length, 1)
    assert.equal(ctx.headers.get("anthropic-beta"), "oauth-2025-04-20")
    assert.equal(named("model_advisor.advisor.refusals").length, 1)
    assert.ok(
      records.some((r) => r.kind === "alert" && r.alert === "advisor-refused"),
    )
    assert.ok(records.some((r) => r.kind === "advice" && r.refused))
    // the original body is not modified by the resend copy
    assert.ok(JSON.stringify(req.body).includes(TOOL_TYPE))

    const next = request()
    await advise.before(next)
    assert.ok(
      !JSON.stringify(next.body).includes(TOOL_TYPE),
      "not attached again",
    )
  })

  it("leaves an unrelated 400 alone", async () => {
    const { advise } = setup()
    const { ctx } = await attached(advise)
    let resent = false
    ctx.resend = async () => ((resent = true), new Response("x"))
    const res = sseResponse(
      JSON.stringify({
        error: { message: "messages: text content blocks must be non-empty" },
      }),
      400,
      "application/json",
    )
    assert.equal(await advise.response(res, ctx), res)
    assert.equal(resent, false)
  })

  it("withoutAdvisor drops an emptied tools list", () => {
    const body = { tools: [{ type: TOOL_TYPE }], system: `a\n\n${SYSTEM_LINE}` }
    assert.deepEqual(withoutAdvisor(body), { system: "a" })
  })
})

describe("long turn without an advisor", () => {
  const long = (over: Partial<HookRequest> = {}) =>
    request(over, {
      messages: [
        { role: "user", content: "do it" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
        },
      ],
    })

  it("alerts once when a turn passes alertSteps steps with no advisor attached", async () => {
    const { advise, records } = setup({
      advisor: { enabled: true, alertSteps: 2, maxContextTokens: 10 },
    })
    await advise.before(request())
    for (let i = 0; i < 5; i++) await advise.before(long())
    const alerts = records.filter((r) => r.kind === "alert")
    assert.equal(alerts.length, 1)
    assert.equal((alerts[0] as any).alert, "long-turn-no-advisor")
  })

  it("alerts again after a new turn starts, and never while the advisor is attached", async () => {
    const tight = setup({
      advisor: { enabled: true, alertSteps: 1, maxContextTokens: 10 },
    })
    for (let i = 0; i < 3; i++) await tight.advise.before(long())
    await tight.advise.before(request())
    for (let i = 0; i < 3; i++) await tight.advise.before(long())
    assert.equal(tight.records.filter((r) => r.kind === "alert").length, 2)

    const open = setup({ advisor: { enabled: true, alertSteps: 1 } })
    for (let i = 0; i < 5; i++) await open.advise.before(long())
    assert.equal(open.records.filter((r) => r.kind === "alert").length, 0)
  })

  it("stays quiet in shadow mode", async () => {
    const { advise, records } = setup({
      mode: "shadow",
      advisor: { enabled: true, alertSteps: 1, maxContextTokens: 10 },
    })
    for (let i = 0; i < 5; i++) await advise.before(long())
    assert.equal(records.filter((r) => r.kind === "alert").length, 0)
  })
})

const v2Config = (
  v2: Partial<RoutingV2Config> = {},
  raw: object = {},
): Config => {
  const cfg = buildConfig({
    mode: "enforce",
    advisor: { enabled: true },
    ...raw,
  }).config
  cfg.v2 = { ...defaultRoutingV2(), enabled: true, ...v2 }
  return cfg
}
const gpt = {
  levels: {
    fast: { model: "openai/gpt-5-mini" },
    standard: { model: "openai/gpt-5" },
    frontier: { model: "openai/gpt-5-pro" },
  },
}
const pluginTool = { name: "advisor", description: "ask", input_schema: {} }

describe("advisor implementation", () => {
  const cases: Array<[string, string, Partial<RoutingV2Config>, string]> = [
    [
      "anthropic below the advisor, auto",
      "anthropic/claude-sonnet-5-5",
      {},
      "native",
    ],
    [
      "bare claude id below the advisor, auto",
      "claude-haiku-5-5",
      {},
      "native",
    ],
    ["executor at the advisor level", "anthropic/claude-opus-5-5", {}, "none"],
    ["a model on no level", "mistral/large", {}, "none"],
    ["another provider, auto", "openai/gpt-5", gpt, "tool"],
    [
      "forced tool on anthropic",
      "claude-sonnet-5-5",
      { advisor: { level: "frontier", impl: "tool" } },
      "tool",
    ],
    [
      "forced native on another provider",
      "openai/gpt-5",
      { ...gpt, advisor: { level: "frontier", impl: "native" } },
      "native",
    ],
    [
      "anthropic executor, other-provider advisor, auto",
      "claude-sonnet-5-5",
      {
        levels: {
          ...defaultRoutingV2().levels,
          frontier: { model: "openai/gpt-5-pro" },
        },
      },
      "tool",
    ],
    [
      "an advisor level that does not exist",
      "claude-sonnet-5-5",
      { advisor: { level: "ultra", impl: "auto" } },
      "none",
    ],
  ]
  for (const [label, executor, v2, want] of cases)
    it(`${label} -> ${want}`, () =>
      assert.equal(advisorImpl(executor, v2Config(v2)), want))

  it("falls back to the tool when the API refused the pairing, but not when forced native", () => {
    const refused = new Set(["claude-sonnet-5-5|claude-opus-5-5"])
    assert.equal(advisorImpl("claude-sonnet-5-5", v2Config(), refused), "tool")
    assert.equal(
      advisorImpl(
        "claude-sonnet-5-5",
        v2Config({ advisor: { level: "frontier", impl: "native" } }),
        refused,
      ),
      "native",
    )
  })

  it("is none when the advisor is disabled", () =>
    assert.equal(
      advisorImpl(
        "claude-sonnet-5-5",
        v2Config({}, { advisor: { enabled: false } }),
      ),
      "none",
    ))

  it("keeps the v1 rule with v2 off", () => {
    const cfg = buildConfig({ advisor: { enabled: true } }).config
    assert.equal(advisorImpl("claude-sonnet-5-5", cfg), "native")
    assert.equal(advisorImpl("claude-opus-5-5", cfg), "none")
    assert.equal(advisorImpl("openai/gpt-5", cfg), "none")
  })

  it("offers the tool only in enforce mode, to executors the tool serves, never to orchestrators", () => {
    const cfg = v2Config(gpt)
    assert.equal(toolActive("openai/gpt-5", "builder", cfg), true)
    assert.equal(toolActive("openai/gpt-5", "build", cfg), false)
    assert.equal(toolActive("openai/gpt-5", undefined, cfg), false)
    assert.equal(toolActive(undefined, "builder", cfg), false)
    assert.equal(toolActive("claude-sonnet-5-5", "builder", cfg), false)
    cfg.mode = "shadow"
    assert.equal(toolActive("openai/gpt-5", "builder", cfg), false)
  })
})

describe("advisor policy with routing v2", () => {
  it("attaches the native tool with the advisor level's model", async () => {
    const { advise } = setup(
      {},
      {
        levels: {
          ...defaultRoutingV2().levels,
          frontier: { model: "anthropic/claude-opus-5-5" },
        },
      },
    )
    const req = request({}, { tools: [pluginTool] })
    req.body.system = [{ type: "text", text: `base\n\n${TOOL_SYSTEM_LINE}` }]
    await advise.before(req)
    const tools = req.body.tools as any[]
    assert.equal(tools.filter((t) => t.name === "advisor").length, 1)
    assert.equal(tools[0].type, TOOL_TYPE)
    assert.equal(tools[0].model, "anthropic/claude-opus-5-5")
    assert.equal(JSON.stringify(req.body).includes(TOOL_SYSTEM_LINE), false)
    assert.ok(JSON.stringify(req.body).includes(SYSTEM_LINE))
  })

  it("leaves the plugin tool and its line when the tool serves the executor", async () => {
    const { advise } = setup({}, gpt)
    const req = request({ model: "openai/gpt-5" }, { tools: [pluginTool] })
    const before = structuredClone(req.body)
    await advise.before(req)
    assert.deepEqual(req.body, before)
    assert.equal(req.headers.get("anthropic-beta"), "oauth-2025-04-20")
  })

  it("removes the plugin tool where the tool does not serve the request", async () => {
    for (const [over, v2] of [
      [{ model: "claude-opus-5-5" }, undefined],
      [{ agent: "build" }, undefined],
      [{ model: "mistral/large" }, undefined],
    ] as const) {
      const { advise } = setup({}, v2 ?? {})
      const req = request(over, { tools: [pluginTool] })
      req.body.system = `base\n\n${TOOL_SYSTEM_LINE}`
      await advise.before(req)
      assert.equal(req.body.tools, undefined)
      assert.equal(req.body.system, "base")
    }
  })

  it("removes the plugin tool in shadow mode too", async () => {
    const { advise } = setup({ mode: "shadow" }, gpt)
    const req = request({ model: "openai/gpt-5" }, { tools: [pluginTool] })
    await advise.before(req)
    assert.equal(req.body.tools, undefined)
  })

  it("does not touch a tool named advisor when v2 is off", async () => {
    const { advise } = setup()
    const req = request({ model: "claude-opus-5-5" }, { tools: [pluginTool] })
    await advise.before(req)
    assert.deepEqual(req.body.tools, [pluginTool])
  })

  it("leaves advisor-tool prompts alone", async () => {
    const { advise } = setup({}, {})
    const req = request(
      {},
      { messages: [{ role: "user", content: `${ADVISOR_MARK}. Question` }] },
    )
    const before = structuredClone(req.body)
    await advise.before(req)
    assert.deepEqual(req.body, before)
  })

  it("after a refusal, falls back to the tool on the next request (auto)", async () => {
    const { advise } = setup({}, {})
    const body = { tools: [{ type: TOOL_TYPE, name: "advisor" }] }
    const req = request({}, body)
    const ctx: HookContext = { ...req, resend: async () => new Response("ok") }
    await advise.response(
      new Response("advisor tool not supported for this model", {
        status: 400,
      }),
      ctx,
    )
    const next = request({}, { tools: [pluginTool] })
    await advise.before(next)
    assert.deepEqual(next.body.tools, [pluginTool])
    assert.equal(next.headers.get("anthropic-beta"), "oauth-2025-04-20")
  })
})
