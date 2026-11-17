import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  appendRecord,
  decisionsPath,
  parseRecords,
  readRecords,
  RecordReader,
  type DecisionRecord,
} from "./decisions.ts"

const dir = () => mkdtempSync(join(tmpdir(), "advisor-decisions-"))

const decision = (n: number): DecisionRecord => ({
  v: 1,
  kind: "decision",
  t: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  id: `d${n}`,
  session: "ses_a",
  agent: "builder",
  mode: "shadow",
  model: "claude-opus-5-5",
  would: "claude-sonnet-5-5",
  tier: "sonnet",
  source: "rule",
  rule: "r",
  reason: "rule r",
})

describe("decisions file", () => {
  it("lives next to the log unless overridden", () => {
    assert.equal(
      decisionsPath({ OPENCODE_MODEL_ADVISOR_LOG: "/x/y/advisor.log" }),
      "/x/y/decisions.jsonl",
    )
    assert.equal(
      decisionsPath({ OPENCODE_MODEL_ADVISOR_DECISIONS: "/z/d.jsonl" }),
      "/z/d.jsonl",
    )
  })

  it("appends one line per record and reads them back in order", () => {
    const path = join(dir(), "nested", "decisions.jsonl")
    appendRecord(decision(1), path)
    appendRecord(decision(2), path)
    const text = readFileSync(path, "utf8")
    assert.equal(text.trim().split("\n").length, 2)
    assert.deepEqual(
      readRecords(path).map((r) => (r as DecisionRecord).id),
      ["d1", "d2"],
    )
  })

  it("skips damaged lines and unknown kinds", () => {
    const records = parseRecords(
      `{"kind":"decision","t":"x"}\nnot json\n{"kind":"other","t":"x"}\n{"t":"x"}\n`,
    )
    assert.equal(records.length, 1)
  })

  it("rolls over to .1 past the size cap and still reads both", () => {
    const path = join(dir(), "decisions.jsonl")
    writeFileSync(path, "x\n".repeat(150_000))
    appendRecord(decision(1), path)
    assert.ok(existsSync(`${path}.1`))
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1)
    assert.equal(readRecords(path).length, 1)
  })

  it("never throws on an unwritable path", () => {
    assert.doesNotThrow(() => appendRecord(decision(1), "/dev/null/x/d.jsonl"))
  })

  it("RecordReader re-reads only when the file changes", () => {
    const path = join(dir(), "decisions.jsonl")
    const reader = new RecordReader(() => path)
    assert.deepEqual(reader.read(), [])
    appendRecord(decision(1), path)
    const first = reader.read()
    assert.equal(first.length, 1)
    assert.equal(reader.read(), first)
    appendRecord(decision(2), path)
    assert.equal(reader.read().length, 2)
  })
})
