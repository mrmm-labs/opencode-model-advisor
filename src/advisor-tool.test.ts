import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  advisorPrompt,
  boundContext,
  createAdvisorTool,
  NOT_ENABLED,
  TOOL_OUTPUT_CAP,
  v1Host,
  v2Host,
  type AskRequest,
  type ToolHost,
  type TranscriptItem,
  type V1Client,
} from "./advisor-tool.ts"
import { ADVISOR_MARK } from "./advise.ts"
import { buildConfig, type Config } from "./config.ts"
import type { AdvisorRecord } from "./decisions.ts"
import type { Span, Telemetry } from "./otel.ts"
import { defaultRoutingV2, type RoutingV2Config } from "./route-v2.ts"
import type { UsageRow } from "./usage.ts"

const gpt: Partial<RoutingV2Config> = {
  levels: {
    fast: { model: "openai/gpt-5-mini" },
    standard: { model: "openai/gpt-5" },
    frontier: { model: "openai/gpt-5-pro" },
  },
}

const configOf = (
  v2: Partial<RoutingV2Config> | false = gpt,
  raw: object = {},
): Config => {
  const cfg = buildConfig({
    mode: "enforce",
    advisor: { enabled: true, maxUses: 2, maxContextTokens: 1000 },
    ...raw,
  }).config
  if (v2) cfg.v2 = { ...defaultRoutingV2(), enabled: true, ...v2 }
  return cfg
}

const users = (...texts: string[]): TranscriptItem[] =>
  texts.map((text) => ({ role: "user", text }))

function setup(
  opts: {
    config?: Config
    items?: TranscriptItem[]
    model?: string | undefined
    reply?: () => Promise<{ text: string; [k: string]: unknown }>
  } = {},
) {
  const cfg = opts.config ?? configOf()
  const asks: AskRequest[] = []
  const records: AdvisorRecord[] = []
  const counts: Array<{ name: string; by: number }> = []
  const spans: Span[] = []
  let items = opts.items ?? users("fix the bug")
  const host: ToolHost = {
    transcript: async () => ({
      items,
      model: "model" in opts ? opts.model : "openai/gpt-5",
    }),
    ask: async (req) => {
      asks.push(req)
      return opts.reply ? opts.reply() : { text: "  Do X, then Y.  " }
    },
  }
  const rows: UsageRow[] = []
  const telemetry = {
    span: (s: Span) => spans.push(s),
    count: (name: string, _a: unknown, by = 1) => counts.push({ name, by }),
    record() {},
    dispose: async () => {},
  } as unknown as Telemetry
  const tool = createAdvisorTool({
    config: () => cfg,
    telemetry,
    record: (r) => records.push(r),
    usage: { add: (row) => rows.push(row) },
    root: async (id) => `root-${id}`,
    now: () => 1_700_000_000_000,
    host,
  })
  return {
    tool,
    asks,
    records,
    rows,
    counts,
    spans,
    setItems: (next: TranscriptItem[]) => (items = next),
  }
}

const call = { sessionID: "ses_1", agent: "builder" }

describe("context bounding", () => {
  it("keeps the newest items, oldest first, within the limit", () => {
    const items = users("aaaa", "bbbb", "cccc")
    assert.equal(
      boundContext(items, 1000),
      "[user] aaaa\n[user] bbbb\n[user] cccc",
    )
    assert.equal(boundContext(items, 23), "[user] bbbb\n[user] cccc")
  })

  it("cuts the item that crosses the limit and keeps its end", () => {
    const out = boundContext(users("x".repeat(100), "recent"), 20)
    assert.ok(out.endsWith("[user] recent"))
    assert.ok(out.startsWith("…"))
    assert.ok(out.length <= 20 + 15)
  })

  it("replaces a tool output over the cap with a stub and keeps one at the cap", () => {
    const big = "y".repeat(TOOL_OUTPUT_CAP + 1)
    const ok = "z".repeat(TOOL_OUTPUT_CAP)
    const out = boundContext(
      [
        { role: "tool", label: "bash ls", text: big },
        { role: "tool", label: "read", text: ok },
      ],
      100_000,
    )
    assert.ok(
      out.includes(`[tool bash ls] [output omitted: ${big.length} chars]`),
    )
    assert.ok(out.includes(`[tool read] ${ok}`))
    assert.ok(!out.includes(big))
  })

  it("is empty for no items or no room", () => {
    assert.equal(boundContext([], 100), "")
    assert.equal(boundContext(users("a"), 0), "")
  })

  it("sends the bounded excerpt, sized by maxContextTokens", async () => {
    const { tool, asks } = setup({
      config: configOf(gpt, {
        advisor: { enabled: true, maxContextTokens: 50 },
      }),
      items: users("old ".repeat(500), "latest question context"),
    })
    await tool.execute("what now?", call)
    const prompt = asks[0].prompt
    assert.ok(prompt.startsWith(ADVISOR_MARK))
    assert.ok(prompt.includes("what now?"))
    assert.ok(prompt.includes("latest question context"))
    assert.ok(prompt.length < 50 * 4 + 700)
  })

  it("wraps the excerpt as data", () => {
    const p = advisorPrompt("q", "ctx")
    assert.ok(p.includes("<<<SESSION\nctx\nSESSION>>>"))
  })
})

describe("advisor tool", () => {
  it("asks the advisor level's model and returns the trimmed answer", async () => {
    const { tool, asks } = setup()
    assert.equal(await tool.execute("plan?", call), "Do X, then Y.")
    assert.deepEqual(asks[0].model, { providerID: "openai", id: "gpt-5-pro" })
  })

  it("follows the configured advisor level", async () => {
    const { tool, asks } = setup({
      config: configOf({
        ...gpt,
        advisor: { level: "standard", impl: "tool" },
      }),
      model: "openai/gpt-5-mini",
    })
    await tool.execute("plan?", call)
    assert.equal(asks[0].model.id, "gpt-5")
  })

  it("uses the configured provider for a model without one", async () => {
    const { tool, asks } = setup({
      config: configOf(
        {
          ...gpt,
          levels: { ...gpt.levels!, frontier: { model: "gpt-5-pro" } },
        },
        { provider: "azure", advisor: { enabled: true } },
      ),
    })
    await tool.execute("plan?", call)
    assert.deepEqual(asks[0].model, { providerID: "azure", id: "gpt-5-pro" })
  })

  it("writes one advice record and the advisor telemetry", async () => {
    const { tool, records, counts, spans } = setup({
      reply: async () => ({
        text: "ok",
        inputTokens: 1200,
        outputTokens: 30,
        cost: 0.04,
      }),
    })
    await tool.execute("plan?", call)
    assert.deepEqual(records, [
      {
        v: 1,
        kind: "advice",
        t: "2023-11-14T22:13:20.000Z",
        session: "ses_1",
        agent: "builder",
        attached: true,
        calls: 1,
        inTokens: 1200,
        outTokens: 30,
        cost: 0.04,
      },
    ])
    const by = (n: string) =>
      counts.filter((c) => c.name === n).map((c) => c.by)
    assert.deepEqual(by("model_advisor.advisor.calls"), [1])
    assert.deepEqual(by("model_advisor.advisor.tokens"), [1200, 30])
    assert.deepEqual(by("model_advisor.advisor.cost_usd"), [0.04])
    assert.equal(spans[0].name, "advisor builder")
    assert.equal(spans[0].traceSession, "root-ses_1")
    assert.equal(spans[0].attrs["advisor.impl"], "tool")
  })

  it("estimates tokens and list-prices an Anthropic advisor when the host reports neither", async () => {
    const { tool, records } = setup({
      config: configOf({
        advisor: { level: "frontier", impl: "tool" },
      }),
      model: "anthropic/claude-sonnet-5-5",
    })
    await tool.execute("plan?", call)
    const r = records[0] as any
    assert.ok(r.inTokens > 0 && r.outTokens > 0)
    assert.ok(r.cost > 0)
  })

  it("enforces maxUses per turn and starts over on a new user message", async () => {
    const { tool, asks, setItems } = setup()
    assert.equal(await tool.execute("1", call), "Do X, then Y.")
    assert.equal(await tool.execute("2", call), "Do X, then Y.")
    assert.match(await tool.execute("3", call), /limit reached \(2 per turn\)/)
    assert.equal(asks.length, 2)
    setItems(users("fix the bug", "now another thing"))
    assert.equal(await tool.execute("4", call), "Do X, then Y.")
    assert.equal(asks.length, 3)
  })

  it("counts uses per session", async () => {
    const { tool, asks } = setup()
    for (const id of ["a", "b"])
      for (let i = 0; i < 2; i++)
        await tool.execute("q", { sessionID: id, agent: "builder" })
    assert.equal(asks.length, 4)
  })

  const refused: Array<[string, Parameters<typeof setup>[0], typeof call]> = [
    ["routing v2 off", { config: configOf(false) }, call],
    [
      "the advisor disabled",
      { config: configOf(gpt, { advisor: { enabled: false } }) },
      call,
    ],
    [
      "shadow mode",
      { config: configOf(gpt, { mode: "shadow", advisor: { enabled: true } }) },
      call,
    ],
    [
      "an executor the native tool serves",
      { model: "anthropic/claude-sonnet-5-5", config: configOf({}) },
      call,
    ],
    ["an executor at the advisor level", { model: "openai/gpt-5-pro" }, call],
    ["an unknown executor model", { model: undefined }, call],
    ["an orchestrator", {}, { sessionID: "ses_1", agent: "build" }],
    ["no agent", {}, { sessionID: "ses_1" }],
  ]
  for (const [label, opts, c] of refused)
    it(`refuses cleanly for ${label}`, async () => {
      const { tool, asks, records } = setup(opts)
      assert.equal(await tool.execute("plan?", c), NOT_ENABLED)
      assert.equal(asks.length, 0)
      assert.equal(records.length, 0)
    })

  it("writes one advisor usage row for the call", async () => {
    const { tool, rows } = setup({
      reply: () => ({
        text: "ok",
        inputTokens: 1000,
        outputTokens: 100,
        cost: 0.5,
      }),
    })
    await tool.execute("q", call)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, "advisor")
    assert.equal(rows[0].agent, "builder")
    assert.equal(rows[0].input, 1000)
    assert.equal(rows[0].output, 100)
    assert.equal(rows[0].cost, 0.5)
    assert.deepEqual(rows[0].sessions, ["ses_1"])
  })

  it("refuses an empty question without calling the advisor", async () => {
    const { tool, asks } = setup()
    assert.match(await tool.execute("  ", call), /needs a question/)
    assert.equal(asks.length, 0)
  })

  it("answers when the transcript cannot be read", async () => {
    const failing = createAdvisorTool({
      config: () => configOf(),
      telemetry: { count() {}, span() {} } as unknown as Telemetry,
      record() {},
      usage: { add() {} },
      root: async (s) => s,
      now: Date.now,
      host: {
        transcript: async () => {
          throw new Error("boom")
        },
        ask: async () => ({ text: "x" }),
      },
    })
    assert.equal(await failing.execute("q", call), NOT_ENABLED)
  })

  it("returns a failure note, records nothing and keeps the use counted when the model call fails", async () => {
    const { tool, records, counts } = setup({
      reply: async () => {
        throw new Error("rate limited")
      },
    })
    assert.match(
      await tool.execute("q", call),
      /advisor failed \(rate limited\)/,
    )
    assert.equal(records.length, 0)
    assert.ok(counts.some((c) => c.name === "model_advisor.advisor.errors"))
    await tool.execute("q", call)
    assert.match(await tool.execute("q", call), /limit reached/)
  })

  it("treats an empty reply as a failure", async () => {
    const { tool, records } = setup({ reply: async () => ({ text: "  " }) })
    assert.match(await tool.execute("q", call), /advisor failed/)
    assert.equal(records.length, 0)
  })

  it("aborts the model call when the caller aborts", async () => {
    const { tool, asks } = setup()
    const abort = new AbortController()
    await tool.execute("q", { ...call, signal: abort.signal })
    assert.equal(asks[0].signal.aborted, false)
    abort.abort()
    assert.equal(asks[0].signal.aborted, true)
  })
})

describe("OpenCode 1 host", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
    {
      info: { role: "assistant", providerID: "openai", modelID: "gpt-5" },
      parts: [
        { type: "text", text: "on it" },
        { type: "text", text: "hidden", synthetic: true },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { cmd: "ls" }, output: "a b" },
        },
        {
          type: "tool",
          tool: "advisor",
          state: { status: "running", input: { question: "q" } },
        },
      ],
    },
  ]

  function fake(over: Partial<Record<string, any>> = {}) {
    const calls: Array<[string, any]> = []
    const client = {
      session: {
        messages: async (o: any) => (
          calls.push(["messages", o]), { data: messages }
        ),
        create: async (o: any) => (
          calls.push(["create", o]), { data: { id: "ses_adv" } }
        ),
        prompt: async (o: any) => {
          calls.push(["prompt", o])
          if (over.prompt) return over.prompt()
          return {
            data: {
              info: {
                cost: 0.02,
                tokens: {
                  input: 100,
                  output: 20,
                  reasoning: 5,
                  cache: { read: 10, write: 0 },
                },
              },
              parts: [{ type: "text", text: "plan" }],
            },
          }
        },
        delete: async (o: any) => (calls.push(["delete", o]), { data: true }),
      },
      tool: { ids: async () => ({ data: ["bash", "read"] }) },
    } satisfies V1Client
    return { client, calls }
  }

  it("reads the transcript and the executor model, skipping hidden text and unfinished tools", async () => {
    const { client } = fake()
    const t = await v1Host(client).transcript("ses_1")
    assert.equal(t.model, "openai/gpt-5")
    assert.deepEqual(t.items, [
      { role: "user", text: "do it" },
      { role: "assistant", text: "on it" },
      { role: "tool", label: 'bash {"cmd":"ls"}', text: "a b" },
    ])
  })

  it("asks through a parentless temporary session with every tool off, then deletes it", async () => {
    const { client, calls } = fake()
    const out = await v1Host(client).ask({
      model: { providerID: "openai", id: "gpt-5-pro" },
      prompt: "P",
      signal: new AbortController().signal,
    })
    assert.deepEqual(out, {
      text: "plan",
      inputTokens: 110,
      outputTokens: 25,
      cost: 0.02,
    })
    const create = calls.find(([n]) => n === "create")![1]
    assert.equal(create.body.parentID, undefined)
    const prompt = calls.find(([n]) => n === "prompt")![1]
    assert.deepEqual(prompt.body.model, {
      providerID: "openai",
      modelID: "gpt-5-pro",
    })
    assert.deepEqual(prompt.body.tools, { bash: false, read: false })
    assert.deepEqual(prompt.body.parts, [{ type: "text", text: "P" }])
    assert.deepEqual(calls.at(-1), ["delete", { path: { id: "ses_adv" } }])
  })

  it("deletes the temporary session when the model errors", async () => {
    const { client, calls } = fake({
      prompt: async () => ({
        data: {
          info: { error: { name: "ApiError", data: { message: "nope" } } },
          parts: [],
        },
      }),
    })
    await assert.rejects(
      v1Host(client).ask({
        model: { providerID: "openai", id: "m" },
        prompt: "P",
        signal: new AbortController().signal,
      }),
      /nope/,
    )
    assert.equal(calls.at(-1)![0], "delete")
  })
})

describe("OpenCode 2 host", () => {
  const ctx = {
    session: {
      get: async () => ({ model: { id: "gpt-5", providerID: "openai" } }),
      context: async () => [
        { type: "user", text: "do it" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "hmm" },
            { type: "text", text: "on it" },
            {
              type: "tool",
              name: "bash",
              state: {
                status: "completed",
                input: { cmd: "ls" },
                content: [{ type: "text", text: "a b" }],
              },
            },
            {
              type: "tool",
              name: "x",
              state: { status: "running", input: {} },
            },
          ],
        },
      ],
    },
    generate: {
      text: async (_: any) => ({ text: "plan" }),
    },
  }

  it("reads the transcript and the executor model", async () => {
    const t = await v2Host(ctx).transcript("ses_1")
    assert.equal(t.model, "openai/gpt-5")
    assert.deepEqual(t.items, [
      { role: "user", text: "do it" },
      { role: "assistant", text: "on it" },
      { role: "tool", label: 'bash {"cmd":"ls"}', text: "a b" },
    ])
  })

  it("asks with a one-shot generation, no session", async () => {
    let seen: any
    const host = v2Host({
      ...ctx,
      generate: { text: async (i: any) => ((seen = i), { text: "plan" }) },
    })
    const out = await host.ask({
      model: { providerID: "openai", id: "gpt-5-pro" },
      prompt: "P",
      signal: new AbortController().signal,
    })
    assert.deepEqual(out, { text: "plan" })
    assert.deepEqual(seen, {
      prompt: "P",
      model: { providerID: "openai", id: "gpt-5-pro" },
    })
  })

  it("stops waiting when aborted", async () => {
    const abort = new AbortController()
    const host = v2Host({
      ...ctx,
      generate: { text: () => new Promise(() => {}) },
    })
    const pending = host.ask({
      model: { providerID: "openai", id: "m" },
      prompt: "P",
      signal: abort.signal,
    })
    abort.abort()
    await assert.rejects(pending, /aborted/)
  })
})
