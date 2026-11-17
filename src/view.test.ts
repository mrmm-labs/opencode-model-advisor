import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AdvisorRecord } from "./decisions.ts"
import {
  AlertWatcher,
  alertToast,
  decisionDetail,
  decisionRows,
  routerPanel,
  shortModel,
} from "./view.ts"

const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString()

const records: AdvisorRecord[] = [
  {
    v: 1,
    kind: "decision",
    t: t(1),
    id: "d1",
    session: "root",
    agent: "builder",
    mode: "shadow",
    model: "claude-opus-5-5",
    would: "claude-sonnet-5-5",
    tier: "sonnet",
    source: "rule",
    rule: "read-only",
    reason: "rule read-only",
  },
  {
    v: 1,
    kind: "link",
    t: t(2),
    session: "child",
    parent: "root",
    decision: "d1",
  },
  {
    v: 1,
    kind: "advice",
    t: t(3),
    session: "child",
    agent: "builder",
    attached: true,
    calls: 2,
    inTokens: 1000,
    outTokens: 100,
    cost: 0.04,
  },
]

const copy = (id: string): AdvisorRecord =>
  Object.assign(structuredClone(records[0]), { id })

const row = {
  agent: "builder",
  models: "opus → sonnet",
  why: "read-only",
  changed: true,
}

describe("router panel", () => {
  it("shows a child its own decision and its advisor usage", () => {
    assert.deepEqual(routerPanel(records, "child"), {
      mode: "shadow",
      rows: [row],
      more: 0,
      advice: "advisor 2 calls $0.04",
    })
  })

  it("shows the dispatching session its decisions and its children's advisor usage", () => {
    const panel = routerPanel(records, "root")
    assert.deepEqual(panel?.rows, [row])
    assert.equal(panel?.advice, "advisor 2 calls $0.04")
  })

  it("marks an unchanged model and is empty for an unrelated session", () => {
    const same = [Object.assign(copy("s"), { would: "claude-opus-5-5" })]
    assert.deepEqual(routerPanel(same, "root")?.rows[0], {
      agent: "builder",
      models: "opus",
      why: "read-only",
      changed: false,
    })
    assert.equal(routerPanel(records, "other"), undefined)
  })

  it("caps a busy dispatcher at four rows, newest first, plus a count", () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) =>
      Object.assign(copy(`d${n}`), { agent: `a${n}` }),
    )
    const panel = routerPanel(many, "root")
    assert.deepEqual(
      panel?.rows.map((r) => r.agent),
      ["a6", "a5", "a4", "a3"],
    )
    assert.equal(panel?.more, 2)
  })
})

describe("short model", () => {
  it("keeps the family and drops provider and version", () => {
    assert.equal(shortModel("anthropic/claude-sonnet-5-5"), "sonnet")
    assert.equal(shortModel("gpt-5"), "gpt-5")
  })
})

describe("decision rows", () => {
  it("lists newest first, at most the limit, with the advisor of the routed child", () => {
    const rows = decisionRows(records, 20)
    assert.equal(rows.length, 1)
    assert.match(rows[0].title, /^\d\d:\d\d  builder  opus → sonnet$/)
    assert.equal(rows[0].description, "read-only · advisor 2 calls $0.04")
    assert.equal(rows[0].category, "Would change the model")
    const many = Array.from({ length: 30 }, (_, n) => copy(`x${n}`))
    const rows2 = decisionRows(many, 20)
    assert.equal(rows2.length, 20)
    assert.equal(rows2[0].value, "x29")
  })

  it("puts changes above kept models and aligns the agent column", () => {
    const kept = Object.assign(copy("k"), {
      agent: "explore",
      would: "claude-opus-5-5",
      t: t(9),
    })
    const rows = decisionRows([records[0], kept], 20)
    assert.deepEqual(
      rows.map((r) => r.category),
      ["Would change the model", "Would keep the model"],
    )
    assert.equal(rows[0].title.indexOf("opus"), rows[1].title.indexOf("opus"))
  })
})

describe("decision detail", () => {
  it("states what ran, what the router picks and why", () => {
    const text = decisionDetail(records, "d1") ?? ""
    assert.match(text, /^builder: ran opus, router would pick sonnet$/m)
    assert.match(text, /^why: rule:read-only: rule read-only$/m)
    assert.equal(decisionDetail(records, "nope"), undefined)
  })
})

describe("alerts", () => {
  const alert = (n: number, kind = "second-failure"): AdvisorRecord => ({
    v: 1,
    kind: "alert",
    t: t(n),
    alert: kind,
    agent: "builder",
    task: "7",
  })

  it("ignores history, then yields each new alert once", () => {
    const w = new AlertWatcher(0)
    assert.deepEqual(w.fresh([alert(1)]), [])
    assert.deepEqual(w.fresh([alert(1)]), [])
    assert.equal(w.fresh([alert(1), alert(2)]).length, 1)
    assert.equal(w.fresh([alert(1), alert(2)]).length, 0)
  })

  it("keeps repeats of the same alert quiet for a while", () => {
    const w = new AlertWatcher(60_000)
    w.fresh([])
    assert.equal(w.fresh([alert(1)], 1_000).length, 1)
    assert.equal(w.fresh([alert(1), alert(2)], 2_000).length, 0)
    assert.equal(w.fresh([alert(1), alert(2), alert(3)], 70_000).length, 1)
  })

  it("words the toast", () => {
    const toast = alertToast(alert(1) as never)
    assert.equal(toast.title, "Task failed twice")
    assert.equal(toast.message, "builder · task 7")
    assert.equal(
      alertToast({ ...(alert(1) as object), alert: "advisor-refused" } as never)
        .variant,
      "error",
    )
  })
})
