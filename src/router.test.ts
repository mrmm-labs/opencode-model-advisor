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

describe("routing v2", () => {
  const v2cfg = (extra: object = {}, v2: object = {}): Config =>
    buildConfig({
      rules: [
        { id: "read-only", when: { agent: ["explore"] }, tier: "opus" },
        { id: "scout", when: { agent: ["scout"] }, tier: "haiku" },
        { id: "risky", when: { prompt: "(?i)\\bauth\\b" }, tier: "opus" },
      ],
      v2: { enabled: true, ...v2 },
      ...extra,
    }).config

  it("is untouched when disabled", () => {
    const off = buildConfig({ v2: { enabled: false } }).config
    const d = decided(
      route(input({ hint: { risk: "critical" } }), off, new RouteState()),
    )
    assert.deepEqual([d.tier, d.source, d.v2], ["sonnet", "default", undefined])
  })

  it("routes by facts and records the v2 detail", () => {
    const d = decided(
      route(
        input({ hint: { risk: "low", files: 20, modules: 5, task: "7" } }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.deepEqual(
      [d.tier, d.source, d.model],
      ["frontier", "v2", "anthropic/claude-opus-5-5"],
    )
    assert.equal(d.v2?.score.total, 4)
    assert.equal(d.v2?.level, "frontier")
    assert.match(d.reason, /risk low, score 4 \(files\+2 modules\+2\) high/)
    assert.match(d.reason, /matrix low×high → frontier/)
  })

  it("uses the default risk and a cheap level for an easy low-risk task", () => {
    const d = decided(
      route(input({ hint: { tier: "T3" } }), v2cfg(), new RouteState()),
    )
    assert.deepEqual([d.tier, d.model], ["fast", "anthropic/claude-haiku-5-5"])
  })

  it("respects a provider prefix on the level model, else qualifies", () => {
    const c = v2cfg(
      { provider: "acme" },
      {
        levels: {
          fast: { model: "other/small" },
          standard: { model: "mid" },
          frontier: { model: "big" },
        },
      },
    )
    const model = (risk: "low" | "medium") =>
      decided(route(input({ hint: { risk } }), c, new RouteState())).model
    assert.equal(model("low"), "other/small")
    assert.equal(model("medium"), "acme/mid")
  })

  it("lets pin and the override marker beat v2", () => {
    const pinned = decided(
      route(input(), v2cfg({ pins: { builder: "haiku" } }), new RouteState()),
    )
    assert.deepEqual([pinned.tier, pinned.source], ["haiku", "pin"])

    const byLevel = decided(
      route(
        input({ override: "fast", hint: { risk: "critical" } }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.deepEqual([byLevel.tier, byLevel.source], ["fast", "override"])
    assert.ok(byLevel.v2)
    assert.match(byLevel.reason, /override prompt marker fast/)

    const byModel = decided(
      route(input({ override: "claude-opus" }), v2cfg(), new RouteState()),
    )
    assert.deepEqual([byModel.tier, byModel.source], ["frontier", "override"])

    const fragment = decided(
      route(input({ override: "sonnet" }), v2cfg(), new RouteState()),
    )
    assert.deepEqual([fragment.tier, fragment.source], ["standard", "override"])

    const v1Tier = decided(
      route(
        input({ override: "big" }),
        v2cfg({ tiers: { small: "m-small", big: "m-big" } }),
        new RouteState(),
      ),
    )
    assert.deepEqual([v1Tier.tier, v1Tier.source], ["big", "override"])
  })

  it("applies a connector override level", () => {
    const d = decided(
      route(
        input({
          hint: { risk: "low" },
          v2: {
            facts: [],
            override: { level: "frontier", detail: "gh label route:frontier" },
            connectors: [{ id: "gh", ok: true, ms: 4, cached: false }],
          },
        }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.deepEqual([d.tier, d.source], ["frontier", "override"])
    assert.equal(d.v2?.connectors[0].id, "gh")
    assert.match(d.reason, /override gh label route:frontier/)
  })

  it("takes connector facts into account, highest risk winning", () => {
    const d = decided(
      route(
        input({
          hint: { risk: "low" },
          v2: {
            facts: [
              {
                fact: "risk",
                value: "high",
                kind: "connector",
                source: "gh",
              },
            ],
            connectors: [],
          },
        }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.equal(d.tier, "frontier")
    assert.equal(d.v2?.disagreements.length, 1)
  })

  it("uses an agent-only rule as a floor by position, never as a ceiling", () => {
    const state = new RouteState()
    const floor = decided(
      route(input({ agent: "explore", hint: { risk: "low" } }), v2cfg(), state),
    )
    assert.deepEqual([floor.tier, floor.rule], ["frontier", "read-only"])
    assert.match(floor.reason, /agent rule read-only floor → frontier/)
    // haiku sits at ladder position 0: no raise above the matrix level
    const low = decided(
      route(
        input({ agent: "scout", hint: { risk: "medium" } }),
        v2cfg(),
        state,
      ),
    )
    assert.deepEqual([low.tier, low.rule], ["standard", undefined])
    // rules that look at more than the agent do not apply in v2
    const other = decided(
      route(
        input({ prompt: "fix auth", hint: { risk: "low" } }),
        v2cfg(),
        state,
      ),
    )
    assert.equal(other.tier, "fast")
  })

  it("does not let the floor beat an operator override", () => {
    const d = decided(
      route(
        input({ agent: "explore", override: "fast" }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.equal(d.tier, "fast")
  })

  it("keeps the retry escalation and the second-failure alert", () => {
    const state = new RouteState()
    const first = decided(
      route(
        input({ hint: { risk: "low", task: "9", retry: 1 } }),
        v2cfg(),
        state,
      ),
    )
    assert.deepEqual(
      [first.tier, first.escalation, first.alert],
      ["standard", "climb", undefined],
    )
    state.set("9", first.tier)
    const second = decided(
      route(
        input({ hint: { risk: "low", task: "9", retry: 2 } }),
        v2cfg(),
        state,
      ),
    )
    assert.deepEqual(
      [second.tier, second.escalation, second.alert],
      ["frontier", "stop", "second-failure"],
    )
    assert.equal(second.v2?.facts.priorFailures?.value, 2)
    const fresh = decided(
      route(input({ hint: { risk: "low", retry: 0 } }), v2cfg(), state),
    )
    assert.equal(fresh.escalation, undefined)
  })

  it("scores derived facts from the prompt", () => {
    const d = decided(
      route(
        input({
          prompt: "x".repeat(250_000),
          hint: { risk: "low", unknowns: 1 },
        }),
        v2cfg(),
        new RouteState(),
      ),
    )
    assert.equal(d.v2?.score.total, 2)
    assert.equal(d.tier, "standard")
  })

  it("never calls the judge", () => {
    const c = v2cfg({ judge: { enabled: true } })
    assert.notEqual(route(input(), c, new RouteState()), "judge")
  })
})
