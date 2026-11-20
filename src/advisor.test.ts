import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createAdvisor, type SessionInfo } from "./advisor.ts"
import { buildConfig, type Config } from "./config.ts"
import type { AdvisorRecord } from "./decisions.ts"
import type { ConnectorResult } from "./route-v2.ts"
import type { Span, Telemetry } from "./otel.ts"
import { traceIdFor } from "./otel.ts"

const RULES = [
  { id: "risky", when: { prompt: "(?i)\\bauth\\b" }, tier: "opus" },
  { id: "read-only", when: { agent: ["explore"] }, tier: "haiku" },
]

function setup(
  extra: object = {},
  host: {
    sessions?: Record<string, SessionInfo>
    judge?: (prompt: string) => Promise<string>
  } = {},
) {
  const config: Config = buildConfig({ rules: RULES, ...extra }).config
  const spans: Span[] = []
  const counts: Array<{
    name: string
    attrs: Record<string, unknown>
    by: number
  }> = []
  const records: Array<{
    name: string
    attrs: Record<string, unknown>
    v: number
  }> = []
  const telemetry = {
    span: (s: Span) => spans.push(s),
    count: (name: string, attrs: Record<string, unknown>, by = 1) =>
      counts.push({ name, attrs, by }),
    record: (name: string, attrs: Record<string, unknown>, v: number) =>
      records.push({ name, attrs, v }),
    dispose: async () => {},
  } as unknown as Telemetry
  const written: AdvisorRecord[] = []
  const advisor = createAdvisor({
    config: () => config,
    telemetry,
    record: (r) => written.push(r),
    session: async (id) => host.sessions?.[id],
    judge: host.judge ? async ({ prompt }) => host.judge!(prompt) : undefined,
  })
  const named = (name: string) => counts.filter((c) => c.name === name)
  return { advisor, spans, counts, records, named, written }
}

const dispatch = (over: object = {}) => ({
  sessionID: "ses_child",
  agent: "builder",
  prompt: "implement it",
  ...over,
})

const SESSIONS = {
  ses_child: { parentID: "ses_mid", model: "claude-opus-5-5" },
  ses_mid: { parentID: "ses_root", model: "claude-opus-5-5" },
  ses_root: { model: "claude-opus-5-5" },
}

describe("shadow mode", () => {
  it("records what it would do and changes nothing", async () => {
    const t = setup({}, { sessions: SESSIONS })
    const applied = await t.advisor.decide(
      dispatch({ agent: "explore", prompt: "look [[advisor: opus]]" }),
    )
    assert.equal(applied, undefined)
    const [span] = t.spans
    assert.equal(span.name, "route explore")
    assert.equal(span.attrs["route.mode"], "shadow")
    assert.equal(
      span.attrs["route.would"],
      "claude-opus-5-5",
      "override beats rule",
    )
    assert.equal(
      span.attrs["route.model"],
      "claude-opus-5-5",
      "the caller's model, untouched",
    )
    assert.equal(span.attrs["route.caller_model"], "claude-opus-5-5")
    assert.equal(span.attrs["route.source"], "override")
  })

  it("flags a dispatch enforce would change", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch({ agent: "explore" }))
    assert.deepEqual(t.named("model_advisor.decisions")[0].attrs, {
      agent: "explore",
      source: "rule",
      mode: "shadow",
      model: "claude-opus-5-5",
      would: "claude-haiku-5-5",
      changed: true,
    })
  })

  it("does not flag a dispatch already on the right model", async () => {
    const t = setup(
      {},
      { sessions: { ses_child: { model: "claude-sonnet-5-5" } } },
    )
    await t.advisor.decide(dispatch())
    assert.equal(t.named("model_advisor.decisions")[0].attrs.changed, false)
  })

  it("puts the span in the root session's trace and records the dispatching session", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch())
    assert.equal(t.spans[0].session, "ses_child")
    assert.equal(t.spans[0].traceSession, "ses_root")
    assert.equal(traceIdFor(t.spans[0].traceSession), traceIdFor("ses_root"))
  })

  it("uses the caller's explicit model over the inherited one", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch({ model: "anthropic/claude-haiku-5-5" }))
    assert.equal(t.spans[0].attrs["route.caller_model"], "claude-haiku-5-5")
  })

  it("records the span attributes without prompt text", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(
      dispatch({
        prompt: "secret plan [[route: task=7 tier=high retry=0 files=3]]",
      }),
    )
    const a = t.spans[0].attrs
    assert.equal(a["route.task"], "7")
    assert.equal(a["route.hint_tier"], "high")
    assert.equal(a["route.retry"], 0)
    assert.ok(!JSON.stringify(t.spans).includes("secret plan"))
    assert.ok(String(a["route.reason"]).length <= 200)
  })

  it("times the decision", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch())
    assert.equal(t.records[0].name, "model_advisor.decision.duration")
    assert.deepEqual(t.records[0].attrs, {
      agent: "builder",
      source: "default",
      mode: "shadow",
    })
  })
})

describe("enforce mode", () => {
  const enforce = { mode: "enforce" }

  it("sets the model and strips markers", async () => {
    const t = setup(enforce, {
      sessions: { ses_child: { model: "claude-sonnet-5-5" } },
    })
    const applied = await t.advisor.decide(
      dispatch({ prompt: "[[route: task=1]]\nreview auth" }),
    )
    assert.deepEqual(applied, {
      model: "anthropic/claude-opus-5-5",
      prompt: "review auth",
    })
  })

  it("sets the model only when it differs from the caller's", async () => {
    const t = setup(enforce, {
      sessions: { ses_child: { model: "claude-sonnet-5-5" } },
    })
    assert.equal(await t.advisor.decide(dispatch()), undefined)
    const strip = await t.advisor.decide(
      dispatch({ prompt: "x [[route: files=1]]" }),
    )
    assert.deepEqual(strip, { prompt: "x" })
    const diff = await t.advisor.decide(dispatch({ agent: "explore" }))
    assert.deepEqual(diff, { model: "anthropic/claude-haiku-5-5" })
  })

  it("overrides a model the caller passed", async () => {
    const t = setup(enforce, { sessions: SESSIONS })
    const applied = await t.advisor.decide(
      dispatch({ agent: "explore", model: "anthropic/claude-opus-5-5" }),
    )
    assert.equal(applied?.model, "anthropic/claude-haiku-5-5")
    assert.equal(t.spans[0].attrs["route.model"], "claude-haiku-5-5")
    assert.equal(t.spans[0].attrs["route.mode"], "enforce")
  })

  it("sets the model when the caller's is unknown", async () => {
    const t = setup(enforce)
    assert.equal(
      (await t.advisor.decide(dispatch()))?.model,
      "anthropic/claude-sonnet-5-5",
    )
  })
})

describe("never routed", () => {
  it("skips continued sessions, orchestrators and dispatches with no agent", async () => {
    const t = setup({ mode: "enforce" }, { sessions: SESSIONS })
    for (const d of [
      dispatch({ continuing: true }),
      dispatch({ agent: "coordinator" }),
      dispatch({ agent: undefined }),
    ]) {
      assert.equal(await t.advisor.decide(d), undefined)
    }
    assert.equal(t.spans.length + t.counts.length, 0)
  })
})

describe("escalation through the advisor", () => {
  it("climbs on the first retry and holds with an alert on the second", async () => {
    const t = setup({ mode: "enforce" }, { sessions: SESSIONS })
    const h = (retry: number) =>
      dispatch({ prompt: `go [[route: task=T1 retry=${retry}]]` })
    await t.advisor.decide(h(0))
    assert.equal(t.spans.at(-1)?.attrs["route.tier"], "sonnet")
    await t.advisor.decide(h(1))
    assert.equal(t.spans.at(-1)?.attrs["route.tier"], "opus")
    assert.equal(t.spans.at(-1)?.attrs["route.source"], "escalation")
    await t.advisor.decide(h(2))
    assert.equal(t.spans.at(-1)?.attrs["route.tier"], "opus")
    assert.equal(t.spans.at(-1)?.attrs["route.alert"], "second-failure")
    assert.deepEqual(
      t.named("model_advisor.escalations").map((c) => c.attrs),
      [
        { agent: "builder", step: "climb" },
        { agent: "builder", step: "stop" },
      ],
    )
  })
})

describe("judge", () => {
  const judged = { judge: { enabled: true, timeoutMs: 200 } }

  it("decides when no rule matched and records the call", async () => {
    const t = setup(judged, {
      sessions: SESSIONS,
      judge: async () => '{"tier":"opus","reason":"touches billing"}',
    })
    await t.advisor.decide(dispatch())
    const a = t.spans[0].attrs
    assert.deepEqual(
      [a["route.source"], a["route.tier"], a["route.reason"]],
      ["judge", "opus", "touches billing"],
    )
    assert.equal(typeof a["route.judge_ms"], "number")
    assert.deepEqual(
      t.named("model_advisor.judge.calls").map((c) => c.attrs),
      [{ outcome: "ok" }],
    )
  })

  it("is skipped when a rule matched", async () => {
    let calls = 0
    const t = setup(judged, {
      sessions: SESSIONS,
      judge: async () => (calls++, '{"tier":"opus"}'),
    })
    await t.advisor.decide(dispatch({ agent: "explore" }))
    assert.equal(calls, 0)
    assert.equal(t.named("model_advisor.judge.calls").length, 0)
  })

  it("falls back to the default with judge-failed on error and on a timeout", async () => {
    const boom = setup(judged, {
      sessions: SESSIONS,
      judge: async () => Promise.reject(new Error("nope")),
    })
    await boom.advisor.decide(dispatch())
    assert.equal(boom.spans[0].attrs["route.source"], "judge-failed")
    assert.equal(boom.spans[0].attrs["route.tier"], "sonnet")
    assert.deepEqual(boom.named("model_advisor.judge.calls")[0].attrs, {
      outcome: "error",
    })

    const slow = setup(judged, {
      sessions: SESSIONS,
      judge: () => new Promise(() => {}),
    })
    await slow.advisor.decide(dispatch())
    assert.equal(slow.spans[0].attrs["route.source"], "judge-failed")
    assert.deepEqual(slow.named("model_advisor.judge.calls")[0].attrs, {
      outcome: "timeout",
    })
  })

  it("is skipped quietly when the host offers no judge", async () => {
    const t = setup(judged, { sessions: SESSIONS })
    await t.advisor.decide(dispatch())
    assert.equal(t.spans[0].attrs["route.source"], "default")
  })
})

const created = (id: string, agent = "builder", model = "claude-opus-5-5") => ({
  type: "session.created",
  data: {
    sessionID: id,
    parentID: "ses_child",
    agent,
    model: { id: model, providerID: "anthropic" },
  },
})
const step = (
  id: string,
  cost: number,
  tokens = {
    input: 1e6,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
) => ({
  type: "session.step.ended",
  data: { sessionID: id, cost, tokens },
})

describe("shadow saving estimate", () => {
  it("counts the saving of a step the would-model would have made cheaper", async () => {
    const t = setup(
      { rules: [{ id: "x", when: { agent: "explore" }, tier: "sonnet" }] },
      { sessions: SESSIONS },
    )
    await t.advisor.decide(dispatch({ agent: "explore" }))
    t.advisor.onEvent(created("ses_grand", "explore"))
    t.advisor.onEvent(step("ses_grand", 10))
    const [s] = t.named("model_advisor.shadow.estimated_saving_usd")
    assert.deepEqual(s.attrs, {
      agent: "explore",
      model: "claude-opus-5-5",
      would: "claude-sonnet-5-5",
    })
    assert.ok(Math.abs(s.by - 4) < 1e-9)
    const [saving] = t.written.filter((r) => r.kind === "saving")
    assert.ok(saving?.kind === "saving" && Math.abs(saving.usd - 4) < 1e-9)
    assert.equal(saving.session, "ses_grand")
  })

  it("prices the tokens at list when the host reports no cost", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch())
    t.advisor.onEvent(created("ses_grand"))
    t.advisor.onEvent(step("ses_grand", 0))
    // 1M opus input tokens = $5; sonnet would be 3/5 of that.
    assert.ok(
      Math.abs(t.named("model_advisor.shadow.estimated_saving_usd")[0].by - 2) <
        1e-9,
    )
  })

  it("counts the extra cost separately when the would-model is dearer", async () => {
    const t = setup(
      {},
      { sessions: { ses_child: { model: "claude-haiku-5-5" } } },
    )
    await t.advisor.decide(dispatch({ prompt: "check auth" }))
    t.advisor.onEvent(created("ses_grand", "builder", "claude-haiku-5-5"))
    t.advisor.onEvent(step("ses_grand", 1))
    assert.equal(t.named("model_advisor.shadow.estimated_saving_usd").length, 0)
    assert.ok(
      Math.abs(
        t.named("model_advisor.shadow.estimated_extra_cost_usd")[0].by - 4,
      ) < 1e-9,
    )
    const saved = t.written.find((r) => r.kind === "saving")
    assert.ok(saved?.kind === "saving" && saved.usd < 0)
  })

  it("ignores sessions it did not route, steps on the right model, and enforce mode", async () => {
    const t = setup(
      {},
      { sessions: { ses_child: { model: "claude-sonnet-5-5" } } },
    )
    await t.advisor.decide(dispatch())
    t.advisor.onEvent(created("ses_a", "other-agent"))
    t.advisor.onEvent(step("ses_a", 5))
    t.advisor.onEvent(created("ses_b", "builder", "claude-sonnet-5-5"))
    t.advisor.onEvent(step("ses_b", 5))
    assert.equal(t.counts.filter((c) => c.name.includes("shadow")).length, 0)

    const e = setup({ mode: "enforce" }, { sessions: SESSIONS })
    await e.advisor.decide(dispatch())
    e.advisor.onEvent(created("ses_c"))
    e.advisor.onEvent(step("ses_c", 5))
    assert.equal(e.counts.filter((c) => c.name.includes("shadow")).length, 0)
  })

  it("follows a model switch in the child and ignores malformed events", async () => {
    const t = setup({}, { sessions: SESSIONS })
    await t.advisor.decide(dispatch())
    t.advisor.onEvent(created("ses_grand", "builder", "claude-sonnet-5-5"))
    t.advisor.onEvent({
      type: "session.model.selected",
      data: { sessionID: "ses_grand", model: { id: "claude-opus-5-5" } },
    })
    t.advisor.onEvent({ type: "session.step.ended" })
    t.advisor.onEvent({ type: "session.step.ended", data: null as never })
    t.advisor.onEvent(step("ses_grand", 10))
    assert.equal(t.named("model_advisor.shadow.estimated_saving_usd").length, 1)
  })
})

describe("robustness", () => {
  it("returns undefined instead of throwing when the host fails", async () => {
    const config = buildConfig({ mode: "enforce" }).config
    const advisor = createAdvisor({
      config: () => {
        throw new Error("config exploded")
      },
      telemetry: {} as Telemetry,
      session: async () => undefined,
    })
    assert.equal(await advisor.decide(dispatch()), undefined)
    assert.equal(config.mode, "enforce")
  })

  it("still decides when the session lookup rejects", async () => {
    const config = buildConfig({ mode: "enforce" }).config
    const spans: Span[] = []
    const advisor = createAdvisor({
      config: () => config,
      telemetry: {
        span: (s: Span) => spans.push(s),
        count() {},
        record() {},
        dispose: async () => {},
      } as unknown as Telemetry,
      session: async () => Promise.reject(new Error("no session api")),
    })
    assert.equal(
      (await advisor.decide(dispatch()))?.model,
      "anthropic/claude-sonnet-5-5",
    )
    assert.equal(spans[0].traceSession, "ses_child")
  })
})

const result = (over: Partial<ConnectorResult> = {}): ConnectorResult => ({
  id: "gh",
  ok: true,
  ms: 5,
  cached: false,
  facts: [],
  ...over,
})

describe("routing v2 dispatch", () => {
  const telemetry = {
    span: () => {},
    count: () => {},
    record: () => {},
    dispose: async () => {},
  } as unknown as Telemetry

  function v2setup(
    lookup?: (task: string, agent: string) => Promise<ConnectorResult[]>,
    extra: object = {},
  ) {
    const records: AdvisorRecord[] = []
    const calls: Array<[string, string]> = []
    const config = buildConfig({
      mode: "enforce",
      v2: { enabled: true },
      ...extra,
    }).config
    const advisor = createAdvisor({
      config: () => config,
      telemetry,
      session: async () => ({ model: "claude-sonnet-5-5" }),
      record: (r) => records.push(r),
      connectors: lookup
        ? {
            lookup: (task, agent) => {
              calls.push([task, agent])
              return lookup(task, agent)
            },
          }
        : undefined,
    })
    const decisions = () =>
      records.filter(
        (r): r is Extract<AdvisorRecord, { kind: "decision" }> =>
          r.kind === "decision",
      )
    return { advisor, records, calls, decisions }
  }

  it("routes by the hint's facts and writes v2 into the record", async () => {
    const t = v2setup()
    const applied = await t.advisor.decide(
      dispatch({
        prompt: "do it\n[[route: task=1 risk=low files=20 modules=3]]",
      }),
    )
    assert.equal(applied?.model, "anthropic/claude-opus-5-5")
    const [d] = t.decisions()
    assert.equal(d.tier, "frontier")
    assert.equal(d.source, "v2")
    assert.equal(d.v2?.score.total, 4)
    assert.equal(d.v2?.facts.risk?.source, "hint")
  })

  it("adds connector facts and records the connector outcome", async () => {
    const t = v2setup(async () => [
      result({
        facts: [
          { fact: "risk", value: "high", kind: "connector", source: "gh" },
        ],
      }),
      result({ id: "slow", ok: false, ms: 3000, error: "timeout" }),
    ])
    await t.advisor.decide(dispatch({ prompt: "[[route: task=42 risk=low]]" }))
    assert.deepEqual(t.calls, [["42", "builder"]])
    const [d] = t.decisions()
    assert.equal(d.tier, "frontier")
    assert.deepEqual(d.v2?.connectors, [
      { id: "gh", ok: true, ms: 5, cached: false },
      { id: "slow", ok: false, ms: 3000, cached: false, error: "timeout" },
    ])
    const alert = t.records.find((r) => r.kind === "alert")
    assert.ok(alert && alert.kind === "alert")
    assert.equal(alert.alert, "fact-disagreement")
    assert.match(alert.detail ?? "", /risk: hint=low vs gh=high/)
  })

  it("applies a connector's override level", async () => {
    const t = v2setup(async () => [
      result({ override: { level: "fast", detail: "gh label route:fast" } }),
    ])
    await t.advisor.decide(
      dispatch({ prompt: "[[route: task=7 risk=critical]]" }),
    )
    const [d] = t.decisions()
    assert.deepEqual([d.tier, d.source], ["fast", "override"])
  })

  it("ignores a failing or throwing connector lookup", async () => {
    const t = v2setup(async () => {
      throw new Error("boom")
    })
    const applied = await t.advisor.decide(
      dispatch({ prompt: "[[route: task=7 risk=low]]" }),
    )
    assert.equal(applied?.model, "anthropic/claude-haiku-5-5")
    assert.equal(t.decisions()[0].v2?.connectors.length, 0)
  })

  it("does not wait past the connector timeout", async () => {
    const t = v2setup(() => new Promise(() => {}), {
      v2: {
        enabled: true,
        connectors: [{ id: "x", command: ["x"], timeoutMs: 20 }],
      },
    })
    const t0 = Date.now()
    await t.advisor.decide(dispatch({ prompt: "[[route: task=7 risk=low]]" }))
    assert.ok(Date.now() - t0 < 2000)
    assert.equal(t.decisions().length, 1)
  })

  it("skips the lookup without a task, and when v2 is off", async () => {
    const none = v2setup(async () => [result()])
    await none.advisor.decide(dispatch({ prompt: "[[route: risk=low]]" }))
    assert.deepEqual(none.calls, [])

    const off = v2setup(async () => [result()], { v2: { enabled: false } })
    await off.advisor.decide(dispatch({ prompt: "[[route: task=1]]" }))
    assert.deepEqual(off.calls, [])
    assert.equal(off.decisions()[0].v2, undefined)
  })
})
