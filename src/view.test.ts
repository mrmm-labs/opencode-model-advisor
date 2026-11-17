import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AdvisorRecord } from "./decisions.ts"
import { AlertWatcher, alertToast, decisionRows, sidebarLines } from "./view.ts"

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

describe("sidebar lines", () => {
  it("shows a child its own decision and its advisor usage", () => {
    assert.deepEqual(sidebarLines(records, "child"), [
      "router shadow · builder→sonnet (would) · rule:read-only",
      "advisor 2 calls $0.04",
    ])
  })

  it("shows the dispatching session its decisions and its children's advisor usage", () => {
    const lines = sidebarLines(records, "root")
    assert.equal(
      lines[0],
      "router shadow · builder→sonnet (would) · rule:read-only",
    )
    assert.equal(lines[1], "advisor 2 calls $0.04")
  })

  it("says applied in enforce mode and is empty for an unrelated session", () => {
    const enforce = records.map((r) =>
      r.kind === "decision" ? { ...r, mode: "enforce" as const } : r,
    )
    assert.match(sidebarLines(enforce, "child")[0], /\(applied\)/)
    assert.deepEqual(sidebarLines(records, "other"), [])
  })

  it("caps a busy dispatcher at two decisions plus a count", () => {
    const many = [1, 2, 3, 4].map((n) => copy(`d${n}`))
    assert.match(sidebarLines(many, "root")[0], /\+2$/)
  })
})

describe("decision rows", () => {
  it("lists newest first, at most the limit, with the advisor of the routed child", () => {
    const rows = decisionRows(records, 20)
    assert.equal(rows.length, 1)
    assert.match(rows[0].title, /builder → sonnet/)
    assert.match(
      rows[0].description,
      /shadow · applied claude-opus-5-5 · would claude-sonnet-5-5 · rule:read-only · rule read-only · advisor 2 calls \$0.04/,
    )
    const many = Array.from({ length: 30 }, (_, n) => copy(`x${n}`))
    const rows2 = decisionRows(many, 20)
    assert.equal(rows2.length, 20)
    assert.equal(rows2[0].value, "x29")
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
