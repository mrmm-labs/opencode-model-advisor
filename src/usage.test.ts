import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  advisorRow,
  appendUsage,
  byModel,
  createUsage,
  dayOf,
  fold,
  inWindow,
  parseUsage,
  readUsage,
  total,
  UsageReader,
  type UsageRow,
} from "./usage.ts"
import type { Telemetry } from "./otel.ts"

const NOW = new Date(2026, 10, 21, 12).getTime()
const DAY = 86_400_000

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  v: 1,
  day: dayOf(NOW),
  provider: "anthropic",
  model: "claude-opus-5-5",
  agent: "builder",
  role: "executor",
  requests: 1,
  input: 100,
  output: 20,
  reasoning: 5,
  cacheRead: 1000,
  cacheWrite: 50,
  cost: 1,
  sessions: ["ses_1"],
  ...over,
})

const tmp = () => join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl")

describe("fold", () => {
  it("merges rows of the same day, provider, model, agent and role, keeping totals and sessions", () => {
    const out = fold([
      row({ sessions: ["a"], wouldSave: 1 }),
      row({ sessions: ["b", "a"], cost: 2, est: true, saved: 3 }),
      row({ role: "advisor", sessions: ["a"] }),
      row({ day: "2020-01-01" }),
    ])
    assert.equal(out.length, 3)
    const merged = out[0]!
    assert.equal(merged.requests, 2)
    assert.equal(merged.cost, 3)
    assert.equal(merged.input, 200)
    assert.equal(merged.est, true)
    assert.equal(merged.wouldSave, 1)
    assert.equal(merged.saved, 3)
    assert.deepEqual(merged.sessions, ["a", "b"])
  })

  it("keeps the sum of every total", () => {
    const rows = [row(), row({ cost: 0.5 }), row({ model: "claude-haiku-5-5" })]
    assert.deepEqual(total(fold(rows)), total(rows))
  })
})

describe("usage file", () => {
  it("appends and reads rows, and skips lines that are not rows", () => {
    const path = tmp()
    appendUsage(row(), path)
    appendUsage(row({ role: "advisor" }), path)
    writeFileSync(path, readFileSync(path, "utf8") + 'not json\n{"v":2}\n')
    assert.deepEqual(
      readUsage(path).map((r) => r.role),
      ["executor", "advisor"],
    )
  })

  it("folds past 2 MB and keeps the totals", () => {
    const path = tmp()
    const filler = row({ sessions: ["x".repeat(5000)] })
    writeFileSync(path, `${JSON.stringify(filler)}\n`.repeat(420))
    assert.ok(statSync(path).size > 2_000_000)
    const before = total(readUsage(path))
    appendUsage(row(), path)
    const after = readUsage(path)
    assert.ok(statSync(path).size < 100_000)
    assert.equal(after.length, 2)
    assert.equal(total(after).requests, before.requests + 1)
    assert.equal(total(after).cost, before.cost + 1)
  })

  it("never throws on an unwritable path", () => {
    assert.doesNotThrow(() => appendUsage(row(), "/dev/null/usage.jsonl"))
  })

  it("re-reads only when the file changed", () => {
    const path = tmp()
    const reader = new UsageReader(() => path)
    assert.deepEqual(reader.read(), [])
    appendUsage(row(), path)
    const first = reader.read()
    assert.equal(first.length, 1)
    assert.equal(reader.read(), first)
  })

  it("parses only well-formed rows", () => {
    assert.equal(parseUsage(`${JSON.stringify(row())}\n\n[]\n`).length, 1)
  })
})

describe("windows and totals", () => {
  const rows = [
    row({ day: dayOf(NOW) }),
    row({ day: dayOf(NOW - 6 * DAY) }),
    row({ day: dayOf(NOW - 7 * DAY) }),
    row({ day: dayOf(NOW - 29 * DAY) }),
    row({ day: dayOf(NOW - 30 * DAY) }),
  ]

  it("today is today only; 7d and 30d include today", () => {
    assert.equal(inWindow(rows, "today", NOW).length, 1)
    assert.equal(inWindow(rows, "7d", NOW).length, 2)
    assert.equal(inWindow(rows, "30d", NOW).length, 4)
  })

  it("groups by model and role, dearest first", () => {
    const lines = byModel([
      row({ cost: 1 }),
      row({ cost: 2 }),
      row({ role: "advisor", cost: 5 }),
      row({ model: "claude-haiku-5-5", cost: 0.1 }),
    ])
    assert.deepEqual(
      lines.map((l) => [l.model, l.role, l.requests, l.cost]),
      [
        ["claude-opus-5-5", "advisor", 1, 5],
        ["claude-opus-5-5", "executor", 2, 3],
        ["claude-haiku-5-5", "executor", 1, 0.1],
      ],
    )
  })
})

describe("usage metrics", () => {
  it("counts requests, tokens by kind and cost, skipping zero kinds", () => {
    const counts: Array<[string, Record<string, unknown>, number]> = []
    const rows: UsageRow[] = []
    const telemetry = {
      count: (n: string, a: Record<string, unknown>, by = 1) =>
        counts.push([n, a, by]),
    } as unknown as Telemetry
    const usage = createUsage(telemetry, (r) => rows.push(r))
    usage.add(
      advisorRow(
        {
          model: "anthropic/claude-opus-5-5",
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.5,
        },
        { agent: "builder", session: "ses_1" },
        NOW,
      ),
    )
    assert.equal(rows[0]!.model, "claude-opus-5-5")
    const attrs = {
      model: "claude-opus-5-5",
      role: "advisor",
      agent: "builder",
    }
    assert.deepEqual(counts, [
      ["model_advisor.usage.requests", attrs, 1],
      ["model_advisor.usage.tokens", { ...attrs, kind: "input" }, 10],
      ["model_advisor.usage.cost_usd", attrs, 0.5],
    ])
  })
})
