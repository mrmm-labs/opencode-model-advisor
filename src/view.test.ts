import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AdvisorRecord } from "./decisions.ts"
import { buildConfig, defaultConfig } from "./config.ts"
import {
  defaultRoutingV2,
  type ConnectorResult,
  type DecisionV2,
  type FactInput,
} from "./route-v2.ts"
import {
  alertLines,
  alertNotice,
  alertTarget,
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
  modeText,
  parseSettingValue,
  prettyModel,
  routerPanel,
  ruleLabels,
  rulesLines,
  scoreLine,
  SECTIONS,
  sessionLines,
  settingRows,
  shortModel,
  suggestionEdit,
  suggestionOptions,
  v2Lines,
  whyText,
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
  const rule = (id: string, over: object = {}) =>
    Object.assign(copy("r"), { rule: id, source: "rule", ...over })
  const rowsOf = (recs: AdvisorRecord[], opts: object = {}) =>
    compactPanel(recs, "root", { now: noon, ...opts })?.rows

  it("says in words what ran, why, what is suggested and what it saves", () => {
    const panel = compactPanel(
      [...records, saving(1, 7), saving(2, 5.4), saving(30, 99)],
      "root",
      { now: noon },
    )
    assert.deepEqual(panel, {
      mode: "shadow",
      rows: [
        { label: "Last task  ", value: "builder · opus 5.5" },
        { label: "Why        ", value: "read-only agent" },
        {
          label: "Suggested  ",
          value: "sonnet 5.5 — cheaper",
          tone: "good",
        },
        { label: "Today      ", value: "would save ≈ $12", tone: "good" },
      ],
    })
  })

  it("hides rows without data and leaves out sessions that routed nothing", () => {
    const same = [Object.assign(copy("s"), { would: "claude-opus-5-5" })]
    assert.deepEqual(
      rowsOf(same)?.map((r) => r.label.trim()),
      ["Last task", "Why"],
    )
    assert.equal(compactPanel(records, "other"), undefined)
    assert.equal(
      rowsOf([...records, saving(30, 5)])?.length,
      3,
      "yesterday's saving is not today's",
    )
  })

  it("names a stronger pick, and a net loss as extra cost", () => {
    const up = Object.assign(copy("u"), {
      model: "claude-haiku-5-5",
      would: "claude-opus-5-5",
    })
    const rows = rowsOf([up, saving(1, -2.5)])
    assert.deepEqual(rows?.[2], {
      label: "Suggested  ",
      value: "opus 5.5 — stronger",
      tone: "changed",
    })
    assert.equal(rows?.[3]?.value, "would cost ≈ $2.50 more")
  })

  it("speaks of savings made in enforce mode, and drops Suggested when the pick was applied", () => {
    const applied = Object.assign(copy("e"), {
      mode: "enforce" as const,
      model: "claude-sonnet-5-5",
    })
    const rows = rowsOf([applied, saving(1, 3)])
    assert.deepEqual(
      rows?.map((r) => r.label.trim()),
      ["Last task", "Why", "Today"],
    )
    assert.equal(rows?.[2]?.value, "saved ≈ $3.00")
  })

  it("prettifies model ids", () => {
    assert.equal(prettyModel("claude-opus-5-5"), "opus 5.5")
    assert.equal(prettyModel("anthropic/claude-sonnet-5-5"), "sonnet 5.5")
    assert.equal(prettyModel("claude-sonnet-4-20250514"), "sonnet 4")
    assert.equal(prettyModel("claude-opus-4-1-20250805"), "opus 4.1")
    assert.equal(prettyModel("openai/gpt-5"), "gpt-5")
  })

  it("puts the mode in words", () => {
    assert.equal(modeText("shadow"), "watching only")
    assert.equal(modeText("enforce"), "choosing models")
  })

  it("maps the stock rules and sources to short sentences", () => {
    const why = (d: object, labels?: Record<string, string>) =>
      whyText(rule("x", d) as never, labels)
    for (const [id, text] of [
      ["critical", "marked critical"],
      ["risky-area", "touches auth / security"],
      ["big", "15+ files"],
      ["review-security", "security review"],
      ["read-only", "read-only agent"],
    ])
      assert.equal(why({ rule: id }), text)
    assert.equal(why({ rule: "my-rule" }), "my rule")
    assert.equal(
      why({ rule: "read-only" }, { "read-only": "never writes" }),
      "never writes",
      "the config's label wins",
    )
    for (const [source, text] of [
      ["default", "no rule matched"],
      ["escalation", "retry after a failure"],
      ["judge", "judged by the advisor"],
      ["pin", "pinned by you"],
    ])
      assert.equal(why({ rule: undefined, source }), text)
  })

  it("explains a v2 decision by its risk and difficulty, shortened to fit", () => {
    const v2 = {
      risk: "medium",
      score: { difficulty: "low" },
      steps: ["matrix medium×low → fast"],
    }
    const d = rule("x", { rule: undefined, source: "v2", v2 }) as never
    assert.equal(whyText(d), "medium risk, low difficulty")
    assert.equal(whyText(d, {}, 20), "medium risk, low effort")
    assert.equal(
      whyText(
        rule("x", {
          rule: undefined,
          source: "v2",
          v2: { ...v2, steps: ["retry 1 → fast"] },
        }) as never,
      ),
      "retry after a failure",
    )
  })

  it("uses a rule's label from the config", () => {
    assert.deepEqual(
      ruleLabels(
        buildConfig({
          rules: [
            {
              id: "a",
              when: { agent: "x" },
              tier: "opus",
              label: " touches billing ",
            },
            { id: "b", when: { agent: "y" }, tier: "opus" },
          ],
        }).config,
      ),
      { a: "touches billing" },
    )
    assert.equal(
      rowsOf([rule("risky-area")], {
        labels: { "risky-area": "auth work" },
      })?.[1]?.value,
      "auth work",
    )
  })

  it("cuts a long line to the sidebar width", () => {
    const long = Object.assign(copy("l"), {
      agent: "reviewer-security-extra",
      rule: "x".repeat(60),
    })
    for (const r of rowsOf([long]) ?? [])
      assert.ok(`  ${r.label}${r.value}`.length <= 38, r.value)
    assert.match(rowsOf([long])?.[1]?.value ?? "", /…$/)
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

  describe("notice", () => {
    const decision = (over: object = {}): AdvisorRecord =>
      ({
        ...structuredClone(records[0]),
        id: "d9",
        agent: "approver",
        session: "root",
        model: "claude-sonnet-5-5",
        would: "claude-opus-5-5",
        tier: "frontier",
        source: "v2",
        summary: "Approve the migration of the billing tables",
        ...over,
      }) as AdvisorRecord
    const failed = (over: object = {}) =>
      ({
        v: 1,
        kind: "alert",
        t: t(5),
        alert: "second-failure",
        agent: "approver",
        session: "root",
        task: "1143",
        decision: "d9",
        detail:
          "risk medium, score 0 low; matrix medium×low → standard; retry 3",
        ...over,
      }) as never
    const link = (session: string, d = "d9"): AdvisorRecord => ({
      v: 1,
      kind: "link",
      t: t(6),
      session,
      parent: "root",
      decision: d,
    })
    const ctx = {
      session: { title: "Fix billing", directory: "/work/acme-api" },
      top: ["frontier"],
    }

    it("tells the operator who, where, what and what the router did", () => {
      const n = alertNotice(failed(), [decision({ mode: "enforce" })], ctx)
      assert.deepEqual(n, {
        title: "Model router · approver failed twice",
        message: [
          "Fix billing · acme-api",
          "Approve the migration of the billing tables",
          "Retrying on opus 5.5 (strongest)",
        ].join("\n"),
        variant: "warning",
        sessionID: "root",
      })
      assert.ok(!n.message.includes("matrix"))
    })

    it("says would in shadow mode, and holds at a stop", () => {
      assert.match(
        alertNotice(failed(), [decision()], ctx).message,
        /^Would retry on opus 5\.5 \(strongest\)$/m,
      )
      assert.match(
        alertNotice(
          failed(),
          [decision({ reason: "retry 2: held at opus, stop climbing" })],
          ctx,
        ).message,
        /^Would hold on opus 5\.5, not climbing further$/m,
      )
      assert.doesNotMatch(
        alertNotice(failed(), [decision({ tier: "standard" })], ctx).message,
        /strongest/,
      )
    })

    it("cuts the task to 80 characters and falls back to the task id", () => {
      const long = alertNotice(
        failed(),
        [decision({ summary: "x".repeat(200) })],
        ctx,
      ).message.split("\n")[1]
      assert.equal(long?.length, 80)
      assert.equal(alertNotice(failed(), [], {}).message, "task 1143")
    })

    it("words the other kinds", () => {
      const disagree = alertNotice(
        failed({
          alert: "fact-disagreement",
          detail: "files: hint=12 vs derived=3 → 12",
        }),
        [decision()],
        ctx,
      )
      assert.equal(disagree.title, "Model router · facts disagree for approver")
      assert.match(
        disagree.message,
        /^Sources disagree on files; the router used 12$/m,
      )
      const judge = alertNotice(
        failed({
          alert: "judge-failed",
          agent: undefined,
          decision: undefined,
        }),
        [],
        {},
      )
      assert.equal(judge.title, "Model router · judge failing")
      assert.match(judge.message, /default tier was used/)
      assert.equal(
        alertNotice(failed({ alert: "advisor-refused" }), [], {}).variant,
        "error",
      )
      assert.equal(
        alertNotice(failed({ alert: "odd-kind" }), [], {}).title,
        "Model router · odd kind",
      )
    })

    it("opens the subagent session when it exists, else the dispatcher", () => {
      assert.equal(alertTarget(failed(), [decision()]), "root")
      assert.equal(
        alertTarget(failed(), [decision(), link("child-1")]),
        "child-1",
      )
      assert.equal(
        alertTarget(failed(), [decision(), link("other", "d1"), link("c2")]),
        "c2",
      )
      assert.equal(alertTarget(failed({ session: undefined }), []), undefined)
    })

    it("finds the decision of an older alert that names none", () => {
      const n = alertNotice(failed({ decision: undefined }), [decision()], ctx)
      assert.match(n.message, /Approve the migration/)
    })
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
