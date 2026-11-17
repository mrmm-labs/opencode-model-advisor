import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildConfig, type Config } from "./config.ts"
import {
  route,
  RouteState,
  skipReason,
  type Decision,
  type RouteInput,
} from "./router.ts"

const cfg = (extra: object = {}): Config =>
  buildConfig({
    rules: [
      {
        id: "critical",
        when: { "hint.tier": ["high", "critical"] },
        tier: "opus",
      },
      {
        id: "risky",
        when: { prompt: "(?i)\\b(auth|security)\\b" },
        tier: "opus",
      },
      { id: "read-only", when: { agent: ["explore"] }, tier: "haiku" },
    ],
    ...extra,
  }).config

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  sessionID: "ses_1",
  agent: "builder",
  prompt: "implement the thing",
  hint: {},
  ...over,
})

const decided = (d: Decision | "judge"): Decision => {
  assert.notEqual(d, "judge")
  return d as Decision
}

describe("route order", () => {
  it("falls to default when nothing matches", () => {
    const d = decided(route(input(), cfg(), new RouteState()))
    assert.deepEqual(
      [d.tier, d.source, d.model],
      ["sonnet", "default", "anthropic/claude-sonnet-5-5"],
    )
  })

  it("rule beats default and records its id", () => {
    const d = decided(
      route(input({ agent: "explore" }), cfg(), new RouteState()),
    )
    assert.deepEqual([d.tier, d.source, d.rule], ["haiku", "rule", "read-only"])
  })

  it("first matching rule wins", () => {
    const d = decided(
      route(
        input({ agent: "explore", prompt: "security audit" }),
        cfg(),
        new RouteState(),
      ),
    )
    assert.equal(d.rule, "risky")
  })

  it("override marker beats rules and accepts tier names and model fragments", () => {
    const c = cfg()
    const byTier = decided(
      route(input({ agent: "explore", override: "opus" }), c, new RouteState()),
    )
    assert.deepEqual([byTier.tier, byTier.source], ["opus", "override"])
    const byModel = decided(
      route(input({ override: "claude-haiku-5-5" }), c, new RouteState()),
    )
    assert.equal(byModel.tier, "haiku")
  })

  it("an unresolvable override is ignored", () => {
    const d = decided(
      route(input({ override: "gpt-9" }), cfg(), new RouteState()),
    )
    assert.equal(d.source, "default")
  })

  it("agent pin beats override; session pin beats agent pin", () => {
    const c = cfg({ pins: { builder: "haiku", "session:ses_1": "opus" } })
    const sessionPinned = decided(
      route(input({ override: "haiku" }), c, new RouteState()),
    )
    assert.deepEqual(
      [sessionPinned.tier, sessionPinned.source],
      ["opus", "pin"],
    )
    const agentPinned = decided(
      route(
        input({ sessionID: "ses_2", override: "opus" }),
        c,
        new RouteState(),
      ),
    )
    assert.deepEqual([agentPinned.tier, agentPinned.source], ["haiku", "pin"])
  })

  it("a hint tier flows into rules", () => {
    const d = decided(
      route(input({ hint: { tier: "critical" } }), cfg(), new RouteState()),
    )
    assert.equal(d.rule, "critical")
  })

  it("does not mutate the router state", () => {
    const state = new RouteState()
    route(input({ hint: { task: "t1" } }), cfg(), state)
    assert.equal(state.get("t1"), undefined)
  })
})

describe("escalation", () => {
  it("climbs one tier above the tier last chosen for the task", () => {
    const state = new RouteState()
    state.set("T1", "sonnet")
    const d = decided(
      route(input({ hint: { task: "T1", retry: 1 } }), cfg(), state),
    )
    assert.deepEqual(
      [d.tier, d.source, d.escalation, d.alert],
      ["opus", "escalation", "climb", undefined],
    )
  })

  it("starts from the rule result when the task is unknown", () => {
    const c = cfg()
    const d = decided(
      route(
        input({ agent: "explore", hint: { task: "new", retry: 1 } }),
        c,
        new RouteState(),
      ),
    )
    assert.equal(d.tier, "sonnet", "haiku rule result, one above")
    const plain = decided(
      route(input({ hint: { task: "new", retry: 1 } }), c, new RouteState()),
    )
    assert.equal(plain.tier, "opus", "default sonnet, one above")
  })

  it("escalates without a task key, from the rule or default", () => {
    const d = decided(
      route(input({ hint: { retry: 1 } }), cfg(), new RouteState()),
    )
    assert.equal(d.tier, "opus")
  })

  it("stays at the top tier", () => {
    const state = new RouteState()
    state.set("T", "opus")
    const d = decided(
      route(input({ hint: { task: "T", retry: 1 } }), cfg(), state),
    )
    assert.equal(d.tier, "opus")
    assert.match(d.reason, /already at opus/)
  })

  it("on the second failure holds the tier and alerts", () => {
    const state = new RouteState()
    state.set("T", "opus")
    const d = decided(
      route(input({ hint: { task: "T", retry: 2 } }), cfg(), state),
    )
    assert.deepEqual(
      [d.tier, d.escalation, d.alert],
      ["opus", "stop", "second-failure"],
    )
    state.set("U", "sonnet")
    const held = decided(
      route(input({ hint: { task: "U", retry: 3 } }), cfg(), state),
    )
    assert.deepEqual([held.tier, held.alert], ["sonnet", "second-failure"])
  })

  it("on the second failure with an unknown task climbs once and alerts", () => {
    const d = decided(
      route(input({ hint: { task: "x", retry: 2 } }), cfg(), new RouteState()),
    )
    assert.deepEqual(
      [d.tier, d.escalation, d.alert],
      ["opus", "stop", "second-failure"],
    )
  })

  it("pins and overrides still beat escalation", () => {
    const state = new RouteState()
    state.set("T", "sonnet")
    const d = decided(
      route(
        input({ override: "haiku", hint: { task: "T", retry: 1 } }),
        cfg(),
        state,
      ),
    )
    assert.deepEqual([d.tier, d.source], ["haiku", "override"])
  })

  it("beats rules", () => {
    const state = new RouteState()
    state.set("T", "haiku")
    const d = decided(
      route(
        input({ agent: "explore", hint: { task: "T", retry: 1 } }),
        cfg(),
        state,
      ),
    )
    assert.equal(d.source, "escalation")
    assert.equal(d.tier, "sonnet")
  })
})

describe("judge", () => {
  const withJudge = () => cfg({ judge: { enabled: true } })

  it("asks for the judge only when no rule matched", () => {
    assert.equal(route(input(), withJudge(), new RouteState()), "judge")
    const ruled = decided(
      route(input({ agent: "explore" }), withJudge(), new RouteState()),
    )
    assert.equal(ruled.source, "rule")
  })

  it("uses the judge's tier and reason", () => {
    const d = decided(
      route(
        input({ judge: { ok: true, tier: "opus", reason: "touches billing" } }),
        withJudge(),
        new RouteState(),
      ),
    )
    assert.deepEqual(
      [d.tier, d.source, d.reason],
      ["opus", "judge", "touches billing"],
    )
  })

  it("a failed judge gives the default tier with source judge-failed", () => {
    const d = decided(
      route(
        input({ judge: { ok: false, reason: "timed out" } }),
        withJudge(),
        new RouteState(),
      ),
    )
    assert.deepEqual(
      [d.tier, d.source, d.reason],
      ["sonnet", "judge-failed", "timed out"],
    )
  })

  it("never runs when disabled", () => {
    assert.equal(
      decided(route(input(), cfg(), new RouteState())).source,
      "default",
    )
  })
})

describe("skipReason", () => {
  it("never routes orchestrators or agentless dispatches", () => {
    const c = cfg()
    assert.equal(skipReason("Coordinator", c), "orchestrator")
    assert.equal(skipReason("plan", c), "orchestrator")
    assert.equal(skipReason(undefined, c), "no agent")
    assert.equal(skipReason("", c), "no agent")
    assert.equal(skipReason("builder", c), undefined)
  })
})

describe("RouteState", () => {
  it("remembers the latest tier and forgets the oldest task past its cap", () => {
    const state = new RouteState()
    state.set("a", "haiku")
    state.set("a", "opus")
    assert.equal(state.get("a"), "opus")
    for (let i = 0; i < 1000; i++) state.set(`t${i}`, "sonnet")
    assert.equal(state.get("a"), undefined)
    assert.equal(state.get("t999"), "sonnet")
  })
})
