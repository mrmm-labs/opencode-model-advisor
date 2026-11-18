import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  collectTasks,
  computeCalibration,
  crontabLine,
  launchdPlist,
  readCosts,
  runCalibration,
  SCHEDULE_LABEL,
  type Calibration,
} from "./calibrate.ts"
import type { AdvisorRecord, DecisionRecord } from "./decisions.ts"
import { parseRecords } from "./decisions.ts"
import {
  defaultRoutingV2,
  type DecisionV2,
  type Difficulty,
  type Facts,
  type Risk,
  type RoutingV2Config,
  type ScoreFn,
} from "./route-v2.ts"

const NOW = Date.parse("2026-06-30T12:00:00Z")
const dir = () => mkdtempSync(join(tmpdir(), "advisor-calibrate-"))

const cfg = (): RoutingV2Config => {
  const c = defaultRoutingV2()
  c.calibration = { minFirstPass: 0.7, minTasks: 2 }
  return c
}

const fact = (value: string | number) => ({
  value,
  kind: "caller" as const,
  source: "hint",
  others: [],
})

// Difficulty by file count: >=15 high, >=5 medium, else low.
const score: ScoreFn = (facts: Facts) => {
  const files = Number(facts.files?.value ?? 0)
  const difficulty: Difficulty =
    files >= 15 ? "high" : files >= 5 ? "medium" : "low"
  return { total: files, difficulty, breakdown: [] }
}

type Spec = {
  task: string
  files: number
  risk?: Risk
  level?: string
  agents?: string[]
  retry?: number
  /** Cost of each dispatch's child session; undefined = no link. */
  costs?: (number | undefined)[]
}

let seq = 0
const records = (spec: Spec, minute = 0): AdvisorRecord[] => {
  const out: AdvisorRecord[] = []
  const agents = spec.agents ?? ["builder"]
  agents.forEach((agent, i) => {
    const id = `d${++seq}`
    const level = spec.level ?? "standard"
    const t = new Date(NOW - 3_600_000 + (minute + i) * 1000).toISOString()
    const retry = spec.retry && i > 0 ? spec.retry : 0
    out.push({
      v: 1,
      kind: "decision",
      t,
      id,
      session: "ses_p",
      agent,
      mode: "shadow",
      model: "m",
      would: "m",
      tier: level,
      source: "v2",
      reason: "r",
      task: spec.task,
      v2: {
        facts: {
          task: fact(spec.task),
          files: fact(spec.files),
          retry: fact(retry),
        },
        risk: spec.risk ?? "medium",
        level,
      } as unknown as DecisionV2,
    })
    const cost = spec.costs?.[i]
    if (cost !== undefined)
      out.push({
        v: 1,
        kind: "link",
        t,
        session: `child_${id}`,
        parent: "ses_p",
        decision: id,
      })
  })
  return out
}

const costMap = (recs: AdvisorRecord[], specs: Spec[]) => {
  const m = new Map<string, number>()
  const ids = recs.filter((r) => r.kind === "decision").map((r) => r.id)
  let i = 0
  for (const s of specs) {
    ;(s.costs ?? []).forEach((c, n) => {
      if (c !== undefined) m.set(`child_${ids[i + n]}`, c)
    })
    i += s.agents?.length ?? 1
  }
  return m
}

const run = (specs: Spec[], c = cfg()) => {
  const recs = specs.flatMap((s, i) => records(s, i * 10))
  return computeCalibration(recs, costMap(recs, specs), c, {
    now: NOW,
    score,
  })
}

describe("task math", () => {
  it("counts retries, first pass and cost per task", () => {
    const specs: Spec[] = [
      { task: "1", files: 1, costs: [0.1] },
      {
        task: "2",
        files: 1,
        agents: ["builder", "builder"],
        costs: [0.1, 0.3],
      },
      {
        task: "3",
        files: 1,
        agents: ["builder", "reviewer"],
        costs: [0.2, 0.2],
      },
      { task: "4", files: 1, agents: ["builder", "builder", "builder"] },
      { task: "5", files: 1, agents: ["builder", "reviewer"], retry: 2 },
    ]
    const recs = specs.flatMap((s, i) => records(s, i * 10))
    const tasks = collectTasks(recs, costMap(recs, specs), cfg(), { score })
    const by = Object.fromEntries(tasks.map((t) => [t.task, t]))
    assert.deepEqual(
      [by["1"]!.retries, by["1"]!.firstPass, by["1"]!.cost],
      [0, true, 0.1],
    )
    assert.deepEqual([by["2"]!.retries, by["2"]!.firstPass], [1, false])
    assert.ok(Math.abs(by["2"]!.cost! - 0.4) < 1e-9)
    assert.deepEqual([by["3"]!.retries, by["3"]!.firstPass], [0, true])
    assert.equal(by["4"]!.retries, 2)
    assert.equal(by["4"]!.cost, null)
    assert.deepEqual([by["5"]!.retries, by["5"]!.firstPass], [2, false])
  })

  it("skips decisions without a task and outside the window", () => {
    const recs = records({ task: "", files: 1 })
    for (const r of recs)
      if (r.kind === "decision") {
        delete r.task
        delete r.v2
      }
    for (const r of records({ task: "old", files: 1 })) {
      r.t = new Date(NOW - 40 * 86_400_000).toISOString()
      recs.push(r)
    }
    const c = computeCalibration(recs, undefined, cfg(), { now: NOW, score })
    assert.equal(c.tasks, 0)
    assert.deepEqual(c.buckets, [])
  })
})

describe("buckets", () => {
  it("keys by risk, difficulty and level", () => {
    const c = run([
      { task: "1", files: 1, risk: "low", level: "fast", costs: [0.1] },
      { task: "2", files: 2, risk: "low", level: "fast", costs: [0.3] },
      { task: "3", files: 20, risk: "high", level: "frontier" },
      {
        task: "4",
        files: 20,
        risk: "high",
        level: "frontier",
        agents: ["builder", "builder"],
      },
    ])
    assert.equal(c.tasks, 4)
    assert.deepEqual(c.buckets, [
      {
        risk: "low",
        difficulty: "low",
        level: "fast",
        tasks: 2,
        firstPass: 1,
        avgRetries: 0,
        costPerTask: 0.2,
      },
      {
        risk: "high",
        difficulty: "high",
        level: "frontier",
        tasks: 2,
        firstPass: 0.5,
        avgRetries: 0.5,
        costPerTask: null,
      },
    ])
  })

  it("v1 records score from tier, files and retry", () => {
    const v1 = (task: string, tier: string, files: number): DecisionRecord =>
      ({
        v: 1,
        kind: "decision",
        t: new Date(NOW - 1000).toISOString(),
        id: `v1_${task}`,
        session: "s",
        agent: "builder",
        mode: "shadow",
        model: "m",
        would: "m",
        tier,
        source: "rule",
        reason: "r",
        task,
        files,
      }) as DecisionRecord
    const c = computeCalibration(
      [v1("a", "haiku", 1), v1("b", "opus", 30)],
      undefined,
      cfg(),
      { now: NOW, score },
    )
    assert.deepEqual(
      c.buckets.map((b) => [b.risk, b.difficulty, b.level]),
      [
        ["low", "low", "haiku"],
        ["high", "high", "opus"],
      ],
    )
  })
})

const trend = (retries: [number, number, number]): Spec[] => {
  const files = [1, 10, 20]
  return files.flatMap((f, i) =>
    [0, 1].map((n) => ({
      task: `t${i}${n}`,
      files: f,
      agents: Array(1 + retries[i]!).fill("builder") as string[],
    })),
  )
}

describe("backtest", () => {
  it("is monotonic when harder buckets retry more", () => {
    const c = run(trend([0, 1, 2]))
    assert.equal(c.backtest.monotonic, true)
    assert.equal(c.backtest.byDifficulty.high.avgRetries, 2)
    assert.equal(c.suggestions.filter((s) => s.kind === "cutoff").length, 0)
  })

  it("is not monotonic when low retries more than medium", () => {
    const c = run(trend([3, 1, 2]))
    assert.equal(c.backtest.monotonic, false)
    const s = c.suggestions.find((x) => x.kind === "cutoff")!
    assert.equal(s.path, "v2.difficulty.cutoffs.medium")
    assert.equal(s.from, 2)
    assert.equal(s.to, 1)
  })

  it("ignores buckets below minTasks", () => {
    const c = run([
      { task: "a", files: 1, agents: ["b", "b", "b"] },
      { task: "b", files: 10 },
    ])
    assert.equal(c.backtest.monotonic, true)
  })

  it("compares cost when retries tie", () => {
    const specs: Spec[] = [
      { task: "a", files: 1, costs: [1] },
      { task: "b", files: 1, costs: [1] },
      { task: "c", files: 10, costs: [0.5] },
      { task: "d", files: 10, costs: [0.5] },
    ]
    assert.equal(run(specs).backtest.monotonic, false)
  })
})

const actionable = (c: Calibration) =>
  c.suggestions.filter((s) => s.kind !== "info")

describe("suggestions", () => {
  const weak: Spec[] = [
    { task: "a", files: 1, risk: "low", level: "fast" },
    { task: "b", files: 1, risk: "low", level: "fast", agents: ["x", "x"] },
    { task: "c", files: 1, risk: "low", level: "fast", agents: ["x", "x"] },
  ]

  it("suggests the next level up when first-pass is under the floor", () => {
    const s = run(weak).suggestions.find((x) => x.kind === "matrix")!
    assert.equal(s.path, "v2.policy.matrix.low.low")
    assert.equal(s.from, "fast")
    assert.equal(s.to, "standard")
    assert.match(s.why, /33%/)
  })

  it("does not suggest from the top level or for small buckets", () => {
    const top = weak.map((s) => ({ ...s, level: "frontier" }))
    assert.equal(actionable(run(top)).length, 0)
    assert.equal(actionable(run(weak.slice(1, 2))).length, 0)
  })

  it("does not suggest when the matrix already moved above the bucket level", () => {
    const c = cfg()
    c.policy.matrix.low.low = "frontier"
    assert.equal(actionable(run(weak, c)).length, 0)
  })

  it("notes levels never chosen as info", () => {
    const info = run(weak).suggestions.filter((s) => s.kind === "info")
    assert.deepEqual(
      info.map((s) => s.id),
      ["unused:standard", "unused:frontier"],
    )
  })

  it("writes the file with the agreed schema and one alert", async () => {
    const d = dir()
    const recs = weak.flatMap((s, i) => records(s, i * 10))
    writeFileSync(
      join(d, "decisions.jsonl"),
      recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
    )
    const c = await runCalibration({
      cfg: cfg(),
      decisions: join(d, "decisions.jsonl"),
      db: join(d, "missing.db"),
      alerts: join(d, "decisions.jsonl"),
      out: join(d, "out", "calibration.json"),
      now: NOW,
      score,
    })
    const file = JSON.parse(
      readFileSync(join(d, "out", "calibration.json"), "utf8"),
    ) as Calibration
    assert.deepEqual(file, c)
    assert.deepEqual(Object.keys(file), [
      "v",
      "t",
      "window_days",
      "tasks",
      "buckets",
      "backtest",
      "suggestions",
    ])
    assert.deepEqual(Object.keys(file.suggestions[0]!), [
      "id",
      "kind",
      "path",
      "from",
      "to",
      "why",
    ])
    const alerts = parseRecords(
      readFileSync(join(d, "decisions.jsonl"), "utf8"),
    ).filter((r) => r.kind === "alert")
    assert.equal(alerts.length, 1)
    assert.equal((alerts[0] as { alert: string }).alert, "calibration")
    assert.equal(c.buckets[0]!.costPerTask, null)
  })
})

describe("cost store", () => {
  it("reads child session costs read-only and tolerates a missing db or table", async () => {
    const d = dir()
    const path = join(d, "opencode.db")
    const db = new DatabaseSync(path)
    db.exec(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, cost REAL, time_created INTEGER)",
    )
    const ins = db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?)")
    for (let i = 0; i < 1200; i++) ins.run(`c${i}`, "p", "builder", i / 100, 1)
    ins.run("nocost", "p", "builder", null, 1)
    db.close()
    const ids = Array.from({ length: 1200 }, (_, i) => `c${i}`).concat([
      "nocost",
      "absent",
    ])
    const costs = await readCosts(path, ids)
    assert.equal(costs?.size, 1200)
    assert.equal(costs?.get("c150"), 1.5)

    assert.equal(await readCosts(join(d, "none.db"), ["x"]), undefined)
    const empty = join(d, "empty.db")
    new DatabaseSync(empty).close()
    assert.equal(await readCosts(empty, ["x"]), undefined)
  })

  it("runs end to end against a fixture store", async () => {
    const d = dir()
    const specs: Spec[] = [
      { task: "1", files: 1, costs: [0.25] },
      {
        task: "2",
        files: 1,
        agents: ["builder", "builder"],
        costs: [0.25, 0.75],
      },
    ]
    const recs = specs.flatMap((s, i) => records(s, i * 10))
    writeFileSync(
      join(d, "decisions.jsonl"),
      recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
    )
    const db = new DatabaseSync(join(d, "opencode.db"))
    db.exec(
      "CREATE TABLE session_v2 (id TEXT, parent_id TEXT, agent TEXT, cost REAL, time_created INTEGER)",
    )
    for (const [id, cost] of costMap(recs, specs))
      db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?)").run(
        id,
        "p",
        "b",
        cost,
        1,
      )
    db.close()
    const c = await runCalibration({
      cfg: cfg(),
      decisions: join(d, "decisions.jsonl"),
      db: join(d, "opencode.db"),
      alerts: join(d, "alerts.jsonl"),
      out: join(d, "calibration.json"),
      now: NOW,
      score,
    })
    assert.equal(c.buckets[0]!.costPerTask, 0.625)
    assert.equal(existsSync(join(d, "calibration.json")), true)
  })
})

describe("scheduler", () => {
  const s = {
    label: SCHEDULE_LABEL,
    command: [
      "/usr/bin/node",
      "--experimental-strip-types",
      "/a b/c.ts",
      "run",
    ],
    hour: 4,
    minute: 15,
    logFile: "/var/log/calibrate.log",
  }

  it("renders a launchd plist", () => {
    const p = launchdPlist(s)
    assert.match(p, /<string>dev\.opencode-model-advisor\.calibrate<\/string>/)
    assert.match(p, /<string>\/a b\/c\.ts<\/string>/)
    assert.match(p, /<key>Hour<\/key>\s*<integer>4<\/integer>/)
    assert.match(p, /<key>Minute<\/key>\s*<integer>15<\/integer>/)
    assert.match(
      p,
      /<key>StandardOutPath<\/key>\s*<string>\/var\/log\/calibrate\.log/,
    )
  })

  it("escapes xml in arguments", () => {
    assert.match(
      launchdPlist({ ...s, command: ["a&b", "<x>"] }),
      /a&amp;b<\/string>\s*<string>&lt;x&gt;/,
    )
  })

  it("renders a crontab line with quoting", () => {
    assert.equal(
      crontabLine(s),
      "15 4 * * * /usr/bin/node --experimental-strip-types '/a b/c.ts' run >> /var/log/calibrate.log 2>&1",
    )
  })
})
