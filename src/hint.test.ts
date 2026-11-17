import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseMarkers } from "./hint.ts"

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
