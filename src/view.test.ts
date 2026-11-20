import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AdvisorRecord } from "./decisions.ts"
import { defaultConfig } from "./config.ts"
import {
  defaultRoutingV2,
  type ConnectorResult,
  type DecisionV2,
  type FactInput,
} from "./route-v2.ts"
import {
  alertLines,
  AlertWatcher,
  alertToast,
  calibrationFile,
  calibrationReport,
  checkDecision,
  compactPanel,
  decisionDetail,
  decisionRows,
  parseCalibration,
  parseHintFacts,
  parseSettingValue,
  routerPanel,
  rulesLines,
  scoreLine,
  SECTIONS,
  sessionLines,
  settingRows,
  shortModel,
  suggestionEdit,
  suggestionOptions,
  v2Lines,
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

describe("compact panel", () => {
  const noon = new Date(2023, 10, 14, 12).getTime()
  const saving = (hoursAgo: number, usd: number): AdvisorRecord => ({
    v: 1,
    kind: "saving",
    t: new Date(noon - hoursAgo * 3_600_000).toISOString(),
    session: "child",
    usd,
  })

  it("shows what ran, what the router would pick and today's saving", () => {
    const panel = compactPanel(
      [...records, saving(1, 7), saving(2, 5.4), saving(30, 99)],
      "root",
      noon,
    )
    assert.deepEqual(panel, {
      mode: "shadow",
      rows: [
        {
          label: "Now     ",
          value: "opus-5-5",
          detail: "(rule read-only)",
        },
        {
          label: "Would   ",
          value: "sonnet-5-5",
          marker: "▼",
          tone: "good",
        },
        { label: "Saved   ", value: "$12 today", tone: "good" },
      ],
    })
  })

  it("hides rows without data and leaves out sessions that routed nothing", () => {
    const same = [Object.assign(copy("s"), { would: "claude-opus-5-5" })]
    const rows = compactPanel(same, "root", noon)?.rows
    assert.deepEqual(
      rows?.map((r) => [r.label.trim(), r.marker]),
      [
        ["Now", undefined],
        ["Would", "="],
      ],
    )
    assert.equal(compactPanel(records, "other", noon), undefined)
    assert.equal(
      compactPanel([...records, saving(30, 5)], "root", noon)?.rows.length,
      2,
      "yesterday's saving is not today's",
    )
  })

  it("marks a dearer pick, calls a net loss extra cost, and omits Would when enforce applied it", () => {
    const up = Object.assign(copy("u"), {
      model: "claude-haiku-5-5",
      would: "claude-opus-5-5",
    })
    const panel = compactPanel([up, saving(1, -2.5)], "root", noon)
    assert.equal(panel?.rows[1]?.marker, "▲")
    assert.deepEqual(panel?.rows[2], {
      label: "Extra   ",
      value: "$2.50 today",
      tone: "changed",
    })
    const applied = Object.assign(copy("e"), {
      mode: "enforce" as const,
      model: "claude-sonnet-5-5",
    })
    assert.deepEqual(
      compactPanel([applied], "root", noon)?.rows.map((r) => r.label.trim()),
      ["Now"],
    )
  })

  it("cuts the reason to the sidebar width", () => {
    const long = Object.assign(copy("l"), { rule: "x".repeat(60) })
    const [now] = compactPanel([long], "root", noon)?.rows ?? []
    assert.ok(`  ${now.label}${now.value}  ${now.detail}`.length <= 38)
    assert.match(now.detail ?? "", /…$/)
  })

  it("moves the verbose detail to text for the dialog", () => {
    assert.deepEqual(sessionLines(records, "child"), [
      "mode: shadow",
      "builder  opus → sonnet",
      "  read-only",
      "",
      "advisor 2 calls $0.04",
    ])
    assert.deepEqual(alertLines([]), ["No alerts yet."])
    assert.match(
      alertLines([
        { v: 1, kind: "alert", t: t(1), alert: "judge-failed", detail: "x" },
      ])[0] ?? "",
      /Judge failing: x$/,
    )
    assert.deepEqual(
      rulesLines({
        mode: "shadow",
        default: "sonnet",
        pins: { builder: "opus" },
        rules: [{ id: "r1", tier: "haiku", test: () => true }],
      }),
      [
        "mode: shadow · default tier: sonnet",
        "",
        "rules:",
        "  r1 → haiku",
        "",
        "pins:",
        "  builder → opus",
      ],
    )
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

const v2: DecisionV2 = {
  facts: {
    risk: {
      value: "high",
      kind: "connector",
      source: "github",
      detail: "label tier:T1",
      others: [{ value: "medium", kind: "caller", source: "hint" }],
    },
    files: { value: 12, kind: "caller", source: "hint", others: [] },
    migration: { value: true, kind: "derived", source: "v1", others: [] },
  },
  disagreements: [
    {
      fact: "risk",
      chosen: "high",
      chosenSource: "github",
      values: [{ value: "medium", source: "hint" }],
    },
  ],
  score: {
    total: 5,
    difficulty: "high",
    breakdown: [
      { fact: "files", add: 2 },
      { fact: "migration", add: 2 },
      { fact: "unknowns", add: 1 },
    ],
  },
  risk: "high",
  matrixLevel: "standard",
  level: "frontier",
  steps: ["risk floor high → frontier"],
  model: "anthropic/claude-opus-5-5",
  connectors: [
    { id: "github", ok: true, ms: 120, cached: false },
    { id: "linear", ok: false, ms: 3000, cached: false, error: "timeout" },
    { id: "jira", ok: true, ms: 0, cached: true },
  ],
}

const withV2 = (): AdvisorRecord[] => [
  { ...(records[0] as any), id: "v", t: t(5), v2 },
]

describe("v2 decision detail", () => {
  it("writes the score as its breakdown", () => {
    assert.equal(
      scoreLine(v2.score),
      "score 5 = files+2 migration+2 unknowns+1 → high",
    )
    assert.equal(
      scoreLine({ total: 0, difficulty: "low", breakdown: [] }),
      "score 0 = no points → low",
    )
  })

  it("shows level, model, risk, difficulty, steps, facts with sources and losers, connectors", () => {
    const text = v2Lines(v2).join("\n")
    assert.match(
      text,
      /^level: frontier \(matrix said standard\) → anthropic\/claude-opus-5-5/,
    )
    assert.match(text, /risk: high · difficulty: high/)
    assert.match(text, /score 5 = files\+2 migration\+2 unknowns\+1 → high/)
    assert.match(text, /steps:\n {2}risk floor high → frontier/)
    assert.match(text, /^! risk\s+high\s+connector:github label tier:T1$/m)
    assert.match(text, /^ {2}files\s+12\s+caller:hint$/m)
    assert.match(text, /risk: medium lost \(caller:hint\)/)
    assert.match(text, /! risk: chose high \(github\); medium \(hint\)/)
    assert.match(text, /github ok 120ms$/m)
    assert.match(text, /linear error 3000ms timeout/)
    assert.match(text, /jira ok 0ms cached/)
  })

  it("is part of the detail only when the record has v2", () => {
    const d = decisionDetail(withV2(), "v") as string
    assert.match(d, /^builder: ran opus/)
    assert.match(d, /\nlevel: frontier/)
    assert.doesNotMatch(decisionDetail(records, "d1") as string, /level:|score/)
  })

  it("adds level and difficulty to the sidebar row and the list", () => {
    const panel = routerPanel(withV2(), "root")
    assert.equal(panel?.rows[0].why, "read-only · frontier high")
    assert.equal(routerPanel(records, "root")?.rows[0].why, "read-only")
    assert.match(decisionRows(withV2())[0].description, /frontier high/)
  })

  it("says so when no fact was recorded", () => {
    const bare = {
      ...v2,
      facts: {},
      disagreements: [],
      steps: [],
      connectors: [],
    }
    const text = v2Lines(bare).join("\n")
    assert.match(text, /facts: none/)
    assert.match(text, /connectors: none/)
    assert.doesNotMatch(text, /steps:|disagreements/)
  })
})

describe("hint facts", () => {
  it("reads facts, aliases tier to risk, ignores unknown keys and bad numbers", () => {
    const f = parseHintFacts(
      "[[route: task=1047 tier=HIGH files=12 modules=x kind=edit migration=true foo=1]]",
    )
    assert.deepEqual(
      f.map((x) => [x.fact, x.value]),
      [
        ["task", "1047"],
        ["risk", "high"],
        ["files", 12],
        ["kind", "edit"],
        ["migration", true],
      ],
    )
    assert.ok(f.every((x) => x.kind === "caller" && x.source === "hint"))
    assert.deepEqual(parseHintFacts("risk=low"), [
      { fact: "risk", value: "low", kind: "caller", source: "hint" },
    ])
  })
})

describe("check", () => {
  const seen: { inputs?: FactInput[]; override?: unknown } = {}
  const explain = (input: any) => {
    seen.inputs = input.inputs
    seen.override = input.override
    return { ...v2, connectors: [] }
  }
  const parseHint = parseHintFacts
  const cfg = () => ({
    ...defaultRoutingV2(),
    connectors: [
      {
        id: "gh",
        match: { task: "^\\d+$" },
        timeoutMs: 1,
        ttlMinutes: 1,
        map: [],
      },
      {
        id: "lin",
        match: { task: "^[A-Z]+-\\d+$" },
        timeoutMs: 1,
        ttlMinutes: 1,
        map: [],
      },
    ],
  })

  it("explains a hint line without connectors and says they are not configured", async () => {
    const r = await checkDecision(
      "[[route: task=7 risk=high]]",
      defaultRoutingV2(),
      { explain, parseHint },
    )
    assert.equal(r.ok, true)
    assert.match(r.lines[0]!, /dry run, nothing dispatched/)
    assert.ok(r.lines.includes("connectors: not configured"))
    assert.match(r.lines.join("\n"), /level: frontier/)
    assert.deepEqual(
      seen.inputs?.map((i) => i.fact),
      ["task", "risk"],
    )
  })

  it("takes a bare id as the task and tests only the connectors that match it", async () => {
    const asked: string[] = []
    const result: ConnectorResult = {
      id: "gh",
      ok: true,
      ms: 40,
      cached: false,
      facts: [{ fact: "risk", value: "high", kind: "connector", source: "gh" }],
      override: { level: "frontier", detail: "label route:frontier" },
    }
    const r = await checkDecision("1047", cfg(), {
      explain,
      parseHint,
      connectors: {
        test: async (id, task) => (asked.push(`${id}:${task}`), result),
      },
    })
    assert.deepEqual(asked, ["gh:1047"])
    assert.deepEqual(
      seen.inputs?.map((i) => i.fact),
      ["task", "risk"],
    )
    assert.deepEqual(seen.override, result.override)
    assert.match(r.lines.join("\n"), /gh ok 40ms/)
    assert.doesNotMatch(r.lines.join("\n"), /lin /)
  })

  it("records a connector that throws and carries on", async () => {
    const r = await checkDecision("1047", cfg(), {
      explain,
      parseHint,
      connectors: {
        test: async () => {
          throw new Error("boom")
        },
      },
    })
    assert.equal(r.ok, true)
    assert.match(r.lines.join("\n"), /gh error boom/)
  })

  it("reports an explain failure and an empty line", async () => {
    const r = await checkDecision("5", defaultRoutingV2(), {
      explain: () => {
        throw new Error("nope")
      },
      parseHint,
    })
    assert.equal(r.ok, false)
    assert.ok(r.lines.includes("explain failed: nope"))
    assert.equal(
      (await checkDecision("  ", defaultRoutingV2(), { explain, parseHint }))
        .ok,
      false,
    )
  })
})

describe("settings rows", () => {
  const cfg = defaultConfig()

  it("lists every section's values, with choices where the set is fixed", () => {
    for (const s of SECTIONS) assert.ok(settingRows(s.id, cfg).length > 0, s.id)
    const policy = settingRows("policy", cfg)
    const cell = policy.find((r) => r.title === "matrix low / high")!
    assert.deepEqual(cell.path, ["v2", "policy", "matrix", "low", "high"])
    assert.equal(cell.shown, "frontier")
    assert.deepEqual(cell.choices, ["fast", "standard", "frontier"])
    assert.equal(policy.filter((r) => r.title.startsWith("matrix")).length, 12)
    assert.equal(policy.find((r) => r.title === "risk floor low")?.shown, "—")
    assert.equal(
      policy.find((r) => r.title === "risk floor low")?.removable,
      false,
    )
    assert.equal(
      policy.find((r) => r.title === "risk floor high")?.removable,
      true,
    )
  })

  it("addresses points and connectors by index, with an add row at the end", () => {
    const pts = settingRows("difficulty", cfg)
    const n = cfg.v2.difficulty.points.length
    assert.deepEqual(pts[0]!.path, ["v2", "difficulty", "points", 0])
    assert.equal(pts[0]!.removable, true)
    const add = pts.find((r) => r.title === "+ add a point")!
    assert.deepEqual(add.path, ["v2", "difficulty", "points", n])
    assert.equal(add.removable, false)
    assert.doesNotThrow(() => JSON.parse(add.initial))
    const withC = {
      ...cfg,
      v2: {
        ...cfg.v2,
        connectors: [
          {
            id: "gh",
            command: ["gh"],
            timeoutMs: 1,
            ttlMinutes: 5,
            map: [],
          },
        ],
      },
    }
    const cr = settingRows("connectors", withC)
    assert.equal(cr[0]!.title, "gh")
    assert.deepEqual(cr[0]!.path, ["v2", "connectors", 0])
    assert.match(cr[0]!.shown, /"ttlMinutes":5/)
    const addC = cr.at(-1)!
    assert.doesNotThrow(() => JSON.parse(addC.initial))
    assert.deepEqual(addC.path, ["v2", "connectors", 1])
  })

  it("exposes mode and the v2 switch, advisor and calibration", () => {
    const m = settingRows("mode", cfg)
    assert.deepEqual(
      m.map((r) => r.path),
      [["mode"], ["v2", "enabled"]],
    )
    assert.equal(m[1]!.kind, "boolean")
    assert.deepEqual(settingRows("advisor", cfg)[1]!.choices, [
      "auto",
      "native",
      "tool",
    ])
    assert.equal(settingRows("calibration", cfg)[0]!.shown, "0.7")
  })
})

describe("setting values", () => {
  it("coerces by kind and says why not", () => {
    assert.deepEqual(parseSettingValue("number", " 3 "), { ok: true, value: 3 })
    assert.equal(parseSettingValue("number", "x").ok, false)
    assert.equal(parseSettingValue("number", "Infinity").ok, false)
    assert.deepEqual(parseSettingValue("boolean", "true"), {
      ok: true,
      value: true,
    })
    assert.equal(parseSettingValue("boolean", "yes").ok, false)
    assert.deepEqual(parseSettingValue("string", " frontier "), {
      ok: true,
      value: "frontier",
    })
    assert.deepEqual(parseSettingValue("json", '{"a":[1]}'), {
      ok: true,
      value: { a: [1] },
    })
    const bad = parseSettingValue("json", "{a")
    assert.equal(bad.ok, false)
    assert.match((bad as { reason: string }).reason, /not valid JSON/)
    assert.equal(parseSettingValue("string", "  ").ok, false)
  })
})

describe("calibration view", () => {
  const file = JSON.stringify({
    v: 1,
    t: "2026-11-01T10:00:00.000Z",
    window_days: 30,
    tasks: 42,
    buckets: [
      {
        risk: "medium",
        difficulty: "high",
        level: "standard",
        tasks: 8,
        firstPass: 0.5,
        avgRetries: 1.4,
        costPerTask: 0.8312,
      },
      {
        risk: "low",
        difficulty: "low",
        level: "fast",
        tasks: 20,
        firstPass: 0.95,
        avgRetries: 0.1,
        costPerTask: null,
      },
    ],
    backtest: {
      monotonic: false,
      byDifficulty: {
        low: { tasks: 20, avgRetries: 0.1, costPerTask: null },
        high: { tasks: 8, avgRetries: 1.4, costPerTask: 0.8312 },
      },
    },
    suggestions: [
      {
        id: "matrix:medium.high.standard",
        kind: "matrix",
        path: "v2.policy.matrix.medium.high",
        from: "frontier",
        to: "frontier",
        why: "first-pass 50% over 8 tasks, under 70%",
      },
      {
        id: "cutoff:high",
        kind: "cutoff",
        path: "v2.difficulty.cutoffs.high",
        from: 4,
        to: 3,
        why: "low has more retries than high",
      },
      {
        id: "unused:fast",
        kind: "info",
        path: "v2.levels.fast",
        from: "fast",
        to: "fast",
        why: "level never chosen in 30 days (12 decisions)",
      },
    ],
  })

  it("is undefined for a missing or foreign file", () => {
    assert.equal(parseCalibration("nope"), undefined)
    assert.equal(parseCalibration('{"v":2,"buckets":[]}'), undefined)
    assert.equal(parseCalibration('{"v":1}'), undefined)
    assert.ok(parseCalibration('{"v":1,"buckets":[]}'))
  })

  it("renders buckets, the monotonic flag, and a dash for an unknown cost", () => {
    const text = calibrationReport(parseCalibration(file)!).join("\n")
    assert.match(text, /last 30 days · 42 tasks/)
    assert.match(text, /monotonic: NO/)
    assert.match(text, /^medium +high +standard +8 +50% +1.4 +\$0.83$/m)
    assert.match(text, /^low +low +fast +20 +95% +0.1 +—$/m)
    assert.match(text, /^high +8 +1.4 +\$0.83$/m)
    assert.match(text, /^low +20 +0.1 +—$/m)
    assert.match(text, /3 suggestions/)
    const ok = parseCalibration(
      '{"v":1,"buckets":[],"backtest":{"monotonic":true}}',
    )!
    const t2 = calibrationReport(ok).join("\n")
    assert.match(t2, /monotonic: yes/)
    assert.match(t2, /no buckets yet/)
    assert.match(t2, /no suggestions/)
  })

  it("offers numeric and string suggestions to apply, info only to read", () => {
    const o = suggestionOptions(parseCalibration(file)!)
    assert.deepEqual(
      o.map((x) => [x.applicable, x.category]),
      [
        [true, "Apply"],
        [true, "Apply"],
        [false, "For information"],
      ],
    )
    assert.equal(o[1]!.title, "v2.difficulty.cutoffs.high: 4 → 3")
    assert.equal(o[2]!.title, "v2.levels.fast")
  })

  it("turns a suggestion into a config edit, keeping a numeric value numeric", () => {
    const c = parseCalibration(file)!
    const cfg = defaultConfig()
    assert.deepEqual(suggestionEdit(c.suggestions[1]!, cfg), {
      ok: true,
      path: ["v2", "difficulty", "cutoffs", "high"],
      value: 3,
    })
  })

  it("refuses info, a stale suggestion and a no-op", () => {
    const c = parseCalibration(file)!
    const cfg = defaultConfig()
    const info = suggestionEdit(c.suggestions[2]!, cfg)
    assert.equal(info.ok, false)
    assert.match((info as { reason: string }).reason, /nothing to apply/)
    const stale = suggestionEdit({ ...c.suggestions[1]!, from: 9 }, cfg)
    assert.match((stale as { reason: string }).reason, /config changed since/)
    assert.equal(suggestionEdit(c.suggestions[0]!, cfg).ok, false)
    assert.equal(
      suggestionEdit(
        { ...c.suggestions[1]!, path: "mode", from: "shadow" },
        cfg,
      ).ok,
      false,
    )
  })

  it("finds the file by env override, else under the data home", () => {
    assert.equal(
      calibrationFile({ OPENCODE_MODEL_ADVISOR_CALIBRATION: "/x/c.json" }),
      "/x/c.json",
    )
    assert.equal(
      calibrationFile({ XDG_DATA_HOME: "/d" }),
      "/d/opencode/model-advisor/calibration.json",
    )
  })
})
