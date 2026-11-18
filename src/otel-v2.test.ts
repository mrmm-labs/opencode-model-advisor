import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  BUCKET_SPAN,
  calibrationPath,
  calibrationSpans,
  connectorSpans,
  exportCalibration,
  FACT_NAMES,
  SUMMARY_SPAN,
  v2Attributes,
  type Calibration,
} from "./otel-v2.ts"
import { decision } from "./otel-v2.fixtures.test.ts"

describe("v2Attributes", () => {
  it("maps the decision, facts with sources and connector calls", () => {
    const a = v2Attributes(decision())
    assert.equal(a["route.level"], "frontier")
    assert.equal(a["route.matrix_level"], "frontier")
    assert.equal(a["route.risk"], "high")
    assert.equal(a["route.difficulty"], "high")
    assert.equal(a["route.score"], 4)
    assert.equal(a["route.score.breakdown"], "files+2 migration+2")
    assert.equal(a["route.steps"], "matrix frontier; floor high -> frontier")
    assert.equal(a["route.disagreements"], 1)
    assert.equal(a["route.disagreement.facts"], "risk")
    assert.equal(a["route.fact.risk"], "high")
    assert.equal(a["route.fact.risk.source"], "connector:github")
    assert.equal(a["route.fact.files"], 18)
    assert.equal(a["route.fact.migration"], true)
    assert.equal(a["route.fact.paths"], "src/a.ts,src/b.ts")
    assert.equal(a["route.fact.paths.source"], "derived:diff")
    assert.equal("route.fact.kind" in a, false)
    assert.equal(a["connector.github.ms"], 42)
    assert.equal(a["connector.github.ok"], true)
    assert.equal(a["connector.github.cached"], false)
    assert.equal(a["connector.github.error"], undefined)
    assert.equal(a["connector.linear.ok"], false)
    assert.equal(a["connector.linear.error"], "timeout")
  })

  it("truncates free text to 200 characters", () => {
    const long = "x".repeat(500)
    const d = decision({
      steps: [long],
      connectors: [{ id: "c", ok: false, ms: 1, cached: false, error: long }],
    })
    d.facts.paths = { value: [long], kind: "derived", source: long, others: [] }
    const a = v2Attributes(d)
    for (const key of [
      "route.steps",
      "connector.c.error",
      "route.fact.paths",
      "route.fact.paths.source",
    ])
      assert.equal(String(a[key]).length, 200, key)
  })

  it("stays bounded: only contract facts, at most 8 connectors", () => {
    const d = decision({
      connectors: Array.from({ length: 30 }, (_, i) => ({
        id: `c${i}`,
        ok: true,
        ms: 1,
        cached: false,
      })),
    })
    ;(d.facts as Record<string, unknown>).bogus = d.facts.files
    for (const name of FACT_NAMES)
      d.facts[name] = {
        value: 1,
        kind: "default",
        source: "config",
        others: [],
      }
    const a = v2Attributes(d)
    assert.equal("route.fact.bogus" in a, false)
    assert.equal("connector.c8.ms" in a, false)
    assert.equal("connector.c7.ms" in a, true)
    assert.ok(Object.keys(a).length <= 9 + FACT_NAMES.length * 2 + 8 * 4)
  })

  it("lists each disagreeing fact once", () => {
    const d = decision()
    d.disagreements.push({ ...d.disagreements[0], chosen: "x" })
    d.disagreements.push({ ...d.disagreements[0], fact: "files" })
    const a = v2Attributes(d)
    assert.equal(a["route.disagreements"], 3)
    assert.equal(a["route.disagreement.facts"], "risk,files")
  })
})

describe("connectorSpans", () => {
  it("makes one span per call in the decision's trace, failed calls as errors", () => {
    const spans = connectorSpans(decision(), {
      session: "s",
      traceSession: "root",
      start: 1,
      end: 2,
    })
    assert.deepEqual(
      spans.map((s) => [s.name, s.attrs["connector.id"], s.error]),
      [
        ["connector github", "github", undefined],
        ["connector linear", "linear", "timeout"],
      ],
    )
    assert.equal(spans[0].traceSession, "root")
    assert.equal(spans[0].v2, undefined)
  })
})

const cal: Calibration = {
  v: 1,
  t: "2026-11-01T00:00:00Z",
  window_days: 30,
  tasks: 40,
  buckets: [
    {
      risk: "low",
      difficulty: "low",
      level: "fast",
      tasks: 12,
      firstPass: 0.92,
      avgRetries: 0.1,
      costPerTask: 0.31,
    },
    {
      risk: "high",
      difficulty: "high",
      level: "frontier",
      tasks: 6,
      firstPass: 0.83,
      avgRetries: 0.4,
      costPerTask: 4.2,
    },
  ],
  backtest: { monotonic: false },
  suggestions: [{ bucket: "low/low" }, { bucket: "high/high" }],
}

describe("calibrationSpans", () => {
  it("makes one span per bucket plus a summary", () => {
    const spans = calibrationSpans(cal, 1000)
    assert.equal(spans.length, 3)
    assert.deepEqual(spans[0].attrs, {
      risk: "low",
      difficulty: "low",
      level: "fast",
      tasks: 12,
      first_pass: 0.92,
      avg_retries: 0.1,
      cost_per_task: 0.31,
    })
    assert.equal(spans[0].name, BUCKET_SPAN)
    assert.equal(spans[0].start, 1000)
    assert.equal(spans[2].name, SUMMARY_SPAN)
    assert.equal(spans[2].attrs.monotonic, false)
    assert.equal(spans[2].attrs.suggestions, 2)
    assert.equal(spans[0].traceSession, spans[2].traceSession)
  })

  it("ignores an unknown schema and malformed buckets", () => {
    assert.deepEqual(calibrationSpans({ ...cal, v: 2 as 1 }, 1), [])
    const bad = {
      ...cal,
      buckets: [{ risk: 1 }, cal.buckets[0]],
    } as Calibration
    assert.equal(calibrationSpans(bad, 1).length, 2)
  })
})

describe("exportCalibration", () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-"))
  const sent: any[] = []
  const post = async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
  }

  it("posts the file's spans", async () => {
    const path = join(dir, "calibration.json")
    writeFileSync(path, JSON.stringify(cal))
    const n = await exportCalibration(
      { endpoint: "http://c" },
      { path, now: 5, post },
    )
    assert.equal(n, 3)
    assert.equal(sent[0].resourceSpans[0].scopeSpans[0].spans.length, 3)
  })

  it("does nothing without a file, a valid file or an endpoint", async () => {
    sent.length = 0
    const path = join(dir, "bad.json")
    writeFileSync(path, "{nope")
    assert.equal(
      await exportCalibration(
        { endpoint: "http://c" },
        { path: join(dir, "missing.json"), post },
      ),
      0,
    )
    assert.equal(
      await exportCalibration({ endpoint: "http://c" }, { path, post }),
      0,
    )
    assert.equal(await exportCalibration(undefined, { path, post }), 0)
    assert.equal(sent.length, 0)
  })

  it("finds the file from the environment, then the data dir", () => {
    assert.equal(
      calibrationPath({ OPENCODE_MODEL_ADVISOR_CALIBRATION: "/x/c.json" }),
      "/x/c.json",
    )
    assert.equal(
      calibrationPath({ XDG_DATA_HOME: "/d" }),
      "/d/opencode/model-advisor/calibration.json",
    )
  })
})
