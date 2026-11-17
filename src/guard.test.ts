import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import { createAdvisor, type Deps } from "./advisor.ts"
import { buildConfig } from "./config.ts"
import type { DecisionRecord, AdvisorRecord } from "./decisions.ts"
import {
  claimOnce,
  firstSeen,
  liveInstance,
  resetShared,
  track,
} from "./guard.ts"
import type { Telemetry } from "./otel.ts"

const telemetry = {
  span() {},
  count() {},
  record() {},
  dispose: async () => {},
} as unknown as Telemetry

function instance(records: AdvisorRecord[]) {
  const config = buildConfig({
    rules: [{ id: "r", when: { agent: "builder" }, tier: "sonnet" }],
  }).config
  const deps: Deps = {
    config: () => config,
    telemetry,
    session: async () => undefined,
    record: (r) => records.push(r),
  }
  return createAdvisor(deps)
}

const dispatch = {
  sessionID: "ses_1",
  callID: "call_1",
  agent: "builder",
  prompt: "x",
}

describe("single instance", () => {
  beforeEach(() => {
    resetShared()
    delete (globalThis as { __claudeAccountsHooks?: unknown })
      .__claudeAccountsHooks
  })

  it("firstSeen and claimOnce answer true once", () => {
    assert.equal(firstSeen("a"), true)
    assert.equal(firstSeen("a"), false)
    assert.equal(claimOnce("x"), true)
    assert.equal(claimOnce("x"), false)
  })

  it("a dispatch seen by three plugin instances is recorded once", async () => {
    const records: AdvisorRecord[] = []
    const three = [instance(records), instance(records), instance(records)]
    for (const advisor of three) await advisor.decide(dispatch)
    assert.equal(records.filter((r) => r.kind === "decision").length, 1)
    assert.equal((records[0] as DecisionRecord).id, "call_1")
  })

  it("distinct calls are each recorded", async () => {
    const records: AdvisorRecord[] = []
    const advisor = instance(records)
    await advisor.decide(dispatch)
    await advisor.decide({ ...dispatch, callID: "call_2" })
    assert.equal(records.filter((r) => r.kind === "decision").length, 2)
  })

  it("hooks keep working after the instance that registered them is gone", () => {
    const a = {}
    const b = {}
    const untrackA = track(a)
    track(b)
    assert.equal(liveInstance(), a)
    untrackA()
    assert.equal(liveInstance(), b)
  })
})
