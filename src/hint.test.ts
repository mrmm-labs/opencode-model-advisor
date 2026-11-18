import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hintFacts, parseMarkers } from "./hint.ts"

describe("parseMarkers", () => {
  it("reads every hint field and removes the line", () => {
    const m = parseMarkers(
      "Fix the thing.\n[[route: task=1047 tier=HIGH retry=1 files=12]]\nThanks.",
    )
    assert.deepEqual(m.hint, {
      task: "1047",
      tier: "high",
      retry: 1,
      files: 12,
    })
    assert.equal(m.stripped, "Fix the thing.\nThanks.")
    assert.equal(m.found, true)
  })

  it("ignores unknown fields and malformed numbers", () => {
    const m = parseMarkers('[[route: color=red retry=two files=-3 task="A 1"]]')
    assert.deepEqual(m.hint, { task: "A 1" })
  })

  it("accepts a partial hint and no hint", () => {
    assert.deepEqual(parseMarkers("[[route: retry=2]] go").hint, { retry: 2 })
    const none = parseMarkers("plain prompt")
    assert.deepEqual(none.hint, {})
    assert.equal(none.found, false)
    assert.equal(none.stripped, "plain prompt")
  })

  it("reads the override and removes it inline", () => {
    const m = parseMarkers("Review this [[advisor: opus]] carefully")
    assert.equal(m.override, "opus")
    assert.equal(m.stripped, "Review this carefully")
  })

  it("handles both markers, uses the first of a repeated marker, strips all", () => {
    const m = parseMarkers(
      "[[advisor: claude-opus-5-5]]\n[[route: task=1]]\nbody\n[[route: task=2]]",
    )
    assert.equal(m.override, "claude-opus-5-5")
    assert.equal(m.hint.task, "1")
    assert.equal(m.stripped, "body\n")
  })

  it("is not fooled by lookalikes", () => {
    const m = parseMarkers(
      "[[routes: task=1]] [[advisory: opus]] [route: task=1]",
    )
    assert.equal(m.found, false)
  })
})

describe("routing v2 hint fields", () => {
  it("reads risk, modules, kind, migration and unknowns", () => {
    const m = parseMarkers(
      "[[route: task=9 risk=High modules=3 kind=Edit migration=yes unknowns=2]]",
    )
    assert.deepEqual(m.hint, {
      task: "9",
      risk: "high",
      modules: 3,
      kind: "edit",
      migration: true,
      unknowns: 2,
    })
  })

  it("accepts yes/no/true/false for migration and ignores bad values", () => {
    const h = (v: string) => parseMarkers(`[[route: migration=${v}]]`).hint
    assert.equal(h("no").migration, false)
    assert.equal(h("TRUE").migration, true)
    assert.equal(h("false").migration, false)
    assert.equal(h("maybe").migration, undefined)
    const bad = parseMarkers(
      "[[route: risk=extreme kind=weird modules=x]]",
    ).hint
    assert.deepEqual(bad, {})
  })

  it("turns the hint into caller facts, with tier as an alias of risk", () => {
    const facts = (line: string) => hintFacts(parseMarkers(line).hint)
    const risk = (line: string) =>
      facts(line).find((i) => i.fact === "risk")?.value
    assert.equal(risk("[[route: tier=T1]]"), "high")
    assert.equal(risk("[[route: tier=t2]]"), "medium")
    assert.equal(risk("[[route: tier=T3]]"), "low")
    assert.equal(risk("[[route: tier=critical]]"), "critical")
    assert.equal(risk("[[route: tier=sonnet]]"), undefined)
    assert.equal(risk("[[route: tier=low risk=high]]"), "high")
    assert.deepEqual(facts("[[route: task=5 files=12 retry=1]]"), [
      { fact: "task", value: "5", kind: "caller", source: "hint" },
      { fact: "retry", value: 1, kind: "caller", source: "hint" },
      { fact: "files", value: 12, kind: "caller", source: "hint" },
    ])
  })

  it("keeps tier as typed for v1 rules", () => {
    assert.equal(parseMarkers("[[route: tier=T1]]").hint.tier, "t1")
  })
})
