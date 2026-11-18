/**
 * What the TUI shows, as plain functions over the decisions stream: the
 * sidebar panel, the decisions list and the alert toasts. No UI types in here.
 */
import { homedir } from "node:os"
import { join } from "node:path"

import { getAt, parsePath, type Path } from "./config-edit.ts"
import type { Config } from "./config.ts"
import type {
  AdviceRecord,
  AdvisorRecord,
  AlertRecord,
  DecisionRecord,
} from "./decisions.ts"
import type {
  ConnectorResult,
  DecisionV2,
  ExplainFn,
  FactInput,
  FactName,
  FactValue,
  RoutingV2Config,
} from "./route-v2.ts"

const money = (usd: number): string => `$${usd.toFixed(2)}`

const sourceLabel = (d: DecisionRecord): string =>
  d.source === "rule" && d.rule ? `rule:${d.rule}` : d.source

type Index = {
  decisions: Map<string, DecisionRecord>
  /** child session -> decision id */
  links: Map<string, string>
  /** child session -> its parent */
  parents: Map<string, string>
  advice: AdviceRecord[]
}

function index(records: AdvisorRecord[]): Index {
  const ix: Index = {
    decisions: new Map(),
    links: new Map(),
    parents: new Map(),
    advice: [],
  }
  for (const r of records) {
    if (r.kind === "decision") ix.decisions.set(r.id, r)
    else if (r.kind === "link") {
      ix.links.set(r.session, r.decision)
      ix.parents.set(r.session, r.parent)
    } else if (r.kind === "advice") ix.advice.push(r)
  }
  return ix
}

type Total = { calls: number; cost: number; would: boolean; refused: boolean }

function adviceFor(ix: Index, sessions: Set<string>): Total {
  const total: Total = { calls: 0, cost: 0, would: false, refused: false }
  for (const a of ix.advice) {
    if (!sessions.has(a.session)) continue
    total.calls += a.calls
    total.cost += a.cost
    total.would ||= !!a.would
    total.refused ||= !!a.refused
  }
  return total
}

export function adviceText(t: Total): string | undefined {
  if (t.calls > 0)
    return `advisor ${t.calls} call${t.calls === 1 ? "" : "s"} ${money(t.cost)}`
  if (t.refused) return "advisor refused"
  if (t.would) return "advisor would attach"
  return undefined
}

/** `claude-sonnet-5-5` -> `sonnet`; anything else is kept as is. */
export const shortModel = (id: string): string =>
  id.replace(/^[\w-]+\//, "").replace(/^claude-([a-z]+)-[\d-]+$/, "$1")

const fit = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n)

export type PanelRow = {
  agent: string
  /** `sonnet` when unchanged, `sonnet → opus` when the router differs. */
  models: string
  why: string
  changed: boolean
}

export type Panel = {
  mode: string
  rows: PanelRow[]
  /** Older decisions not shown. */
  more: number
  advice?: string
}

const panelRow = (d: DecisionRecord): PanelRow => {
  const ran = shortModel(d.model)
  const would = shortModel(d.would)
  return {
    agent: d.agent,
    models: ran === would ? ran : `${ran} → ${would}`,
    why: [
      sourceLabel(d).replace(/^rule:/, ""),
      d.v2 && `${d.v2.level} ${d.v2.score.difficulty}`,
    ]
      .filter(Boolean)
      .join(" · "),
    changed: ran !== would,
  }
}

/**
 * The sidebar block for one session: its own routing if it is a routed child,
 * else the latest decisions it dispatched, newest first. Undefined when the
 * session has nothing to show.
 */
export function routerPanel(
  records: AdvisorRecord[],
  session: string,
  limit = 4,
): Panel | undefined {
  const ix = index(records)
  const family = new Set([session])
  for (const [child, parent] of ix.parents)
    if (parent === session) family.add(child)
  const advice = adviceText(adviceFor(ix, family))
  const own = ix.links.get(session)
  const owned = own ? ix.decisions.get(own) : undefined
  const mine = owned
    ? [owned]
    : [...ix.decisions.values()].filter((d) => d.session === session)
  if (mine.length === 0 && !advice) return undefined
  const shown = mine.slice(-limit).toReversed()
  return {
    mode: mine.at(-1)?.mode ?? "shadow",
    rows: shown.map(panelRow),
    more: mine.length - shown.length,
    ...(advice ? { advice } : {}),
  }
}

export type DecisionRow = {
  title: string
  description: string
  category: string
  value: string
}

const p = (n: number) => String(n).padStart(2, "0")

const clock = (iso: string): string => {
  const d = new Date(iso)
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The newest `limit` decisions, newest first, as fixed columns
 * (`19:05  general         sonnet → opus`) with the reason as description,
 * grouped into those the router would change and those it would keep.
 */
export function decisionRows(
  records: AdvisorRecord[],
  limit = 20,
): DecisionRow[] {
  const ix = index(records)
  const childOf = new Map<string, string>()
  for (const [child, id] of ix.links) childOf.set(id, child)
  const recent = [...ix.decisions.values()].slice(-limit).toReversed()
  const width = Math.min(16, Math.max(5, ...recent.map((d) => d.agent.length)))
  const rows = recent.map((d) => {
    const row = panelRow(d)
    const child = childOf.get(d.id)
    const advice = child
      ? adviceText(adviceFor(ix, new Set([child])))
      : undefined
    return {
      title: `${clock(d.t)}  ${fit(d.agent, width)}  ${row.models}`,
      description: [row.why, d.task && `task ${d.task}`, advice]
        .filter(Boolean)
        .join(" · "),
      category:
        d.mode === "enforce"
          ? "Applied"
          : row.changed
            ? "Would change the model"
            : "Would keep the model",
      value: d.id,
    }
  })
  // The dialog groups by category in order of first appearance; keep the
  // changes on top, newest first inside each group.
  const order = ["Applied", "Would change the model", "Would keep the model"]
  return rows.toSorted(
    (x, y) => order.indexOf(x.category) - order.indexOf(y.category),
  )
}

/** Everything known about one decision, one fact per line, for a detail toast. */
export function decisionDetail(
  records: AdvisorRecord[],
  id: string,
): string | undefined {
  const d = index(records).decisions.get(id)
  if (!d) return undefined
  return [
    `${d.agent}: ran ${shortModel(d.model)}, router ${d.mode === "enforce" ? "applied" : "would pick"} ${shortModel(d.would)}`,
    `why: ${sourceLabel(d)}: ${d.reason}`,
    d.task ? `task: ${d.task}` : undefined,
    `at: ${new Date(d.t).toLocaleString()}`,
    ...(d.v2 ? ["", ...v2Lines(d.v2)] : []),
  ]
    .filter((l) => l !== undefined)
    .join("\n")
}

export function alertToast(a: AlertRecord): {
  title: string
  message: string
  variant: "warning" | "error"
} {
  const titles: Record<string, string> = {
    "second-failure": "Task failed twice",
    "judge-failed": "Judge failing",
    "advisor-refused": "Advisor refused",
    "long-turn-no-advisor": "Long turn, no advisor",
  }
  const who = [a.agent, a.task && `task ${a.task}`].filter(Boolean).join(" · ")
  return {
    title: titles[a.alert] ?? a.alert,
    message: [who, a.detail].filter(Boolean).join(": ") || a.alert,
    variant: a.alert === "advisor-refused" ? "error" : "warning",
  }
}

const alertKey = (a: AlertRecord) => `${a.t}|${a.alert}|${a.session}|${a.agent}`

/** Yields each alert once, and none that were already in the file when it started. */
export class AlertWatcher {
  private seen: Set<string> | undefined
  private lastShown = new Map<string, number>()
  private quietMs: number

  constructor(quietMs = 60_000) {
    this.quietMs = quietMs
  }

  fresh(records: AdvisorRecord[], now = Date.now()): AlertRecord[] {
    const alerts = records.filter((r): r is AlertRecord => r.kind === "alert")
    if (!this.seen) {
      this.seen = new Set(alerts.map(alertKey))
      return []
    }
    const out: AlertRecord[] = []
    for (const a of alerts) {
      const k = alertKey(a)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      const kind = `${a.alert}|${a.agent}|${a.task}`
      if (now - (this.lastShown.get(kind) ?? -Infinity) < this.quietMs) continue
      this.lastShown.set(kind, now)
      out.push(a)
    }
    this.seen = new Set(alerts.map(alertKey))
    return out
  }
}

// ---- routing v2: decision detail and the check command ----

const showValue = (v: FactValue | undefined): string =>
  v === undefined ? "—" : Array.isArray(v) ? v.join(",") : String(v)

const sourceText = (kind: string, source: string, detail?: string): string =>
  `${kind}:${source}${detail ? ` ${detail}` : ""}`

/** `score 5 = files+2 migration+2 unknowns+1 → high` */
export const scoreLine = (score: DecisionV2["score"]): string =>
  `score ${score.total} = ${
    score.breakdown.length > 0
      ? score.breakdown.map((b) => `${b.fact}+${b.add}`).join(" ")
      : "no points"
  } → ${score.difficulty}`

/** Left-aligns each column to its widest cell, except the last. */
function table(rows: string[][]): string[] {
  const widths: number[] = []
  for (const row of rows)
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length)
    })
  return rows.map((row) =>
    row
      .map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd(),
  )
}

export const connectorLines = (
  list: DecisionV2["connectors"],
  none = "connectors: none",
): string[] =>
  list.length === 0
    ? [none]
    : [
        "connectors:",
        ...list.map(
          (c) =>
            `  ${c.id} ${c.ok ? "ok" : "error"} ${c.ms}ms${c.cached ? " cached" : ""}${c.error ? ` ${c.error}` : ""}`,
        ),
      ]

/**
 * What a v2 decision decided and why: level and model, risk and difficulty,
 * the score breakdown, the steps that moved the level, each fact with its
 * source and the values that lost, the disagreements and the connectors.
 * A fact whose sources disagreed is marked `!`.
 */
export function v2Lines(
  v2: DecisionV2,
  connectors: string[] = connectorLines(v2.connectors),
): string[] {
  const disputed = new Set(v2.disagreements.map((d) => d.fact))
  const facts = Object.entries(v2.facts) as [
    FactName,
    NonNullable<DecisionV2["facts"][FactName]>,
  ][]
  const rows = facts.map(([name, f]) => [
    `${disputed.has(name) ? "!" : " "} ${name}`,
    showValue(f.value),
    sourceText(f.kind, f.source, f.detail),
  ])
  const lost = facts.flatMap(([name, f]) =>
    f.others.map(
      (o) => `    ${name}: ${showValue(o.value)} lost (${o.kind}:${o.source})`,
    ),
  )
  return [
    `level: ${v2.level}${v2.matrixLevel !== v2.level ? ` (matrix said ${v2.matrixLevel})` : ""} → ${v2.model}`,
    `risk: ${v2.risk} · difficulty: ${v2.score.difficulty}`,
    scoreLine(v2.score),
    ...(v2.steps.length > 0
      ? ["steps:", ...v2.steps.map((s) => `  ${s}`)]
      : []),
    ...(rows.length > 0
      ? ["facts (fact, value, source):", ...table(rows)]
      : ["facts: none"]),
    ...(lost.length > 0 ? ["losing values:", ...lost] : []),
    ...(v2.disagreements.length > 0
      ? [
          "! disagreements:",
          ...v2.disagreements.map(
            (d) =>
              `  ! ${d.fact}: chose ${showValue(d.chosen)} (${d.chosenSource}); ${d.values
                .map((v) => `${showValue(v.value)} (${v.source})`)
                .join(", ")}`,
          ),
        ]
      : []),
    ...connectors,
  ]
}

/** Facts from a `[[route: task=1047 risk=high files=12]]` line; `tier=` is an alias of `risk`. */
export function parseHintFacts(text: string): FactInput[] {
  const body = /\[\[\s*route\s*:([^\]\n]*)\]\]/i.exec(text)?.[1] ?? text
  const out: FactInput[] = []
  const numeric: FactName[] = [
    "files",
    "modules",
    "unknowns",
    "retry",
    "priorFailures",
    "promptTokens",
  ]
  for (const [, key, raw] of body.matchAll(
    /([a-z_]+)\s*=\s*("[^"]*"|[^\s\]]+)/gi,
  )) {
    const name = key!.toLowerCase() === "tier" ? "risk" : key!
    const v = raw!.replace(/^"|"$/g, "")
    let value: FactValue | undefined
    if ((numeric as string[]).includes(name))
      value = /^\d{1,9}$/.test(v) ? Number(v) : undefined
    else if (name === "migration")
      value = v === "true" ? true : v === "false" ? false : undefined
    else if (name === "task" || name === "kind" || name === "risk")
      value = name === "task" ? v : v.toLowerCase()
    if (value === undefined || value === "") continue
    out.push({
      fact: name as FactName,
      value,
      kind: "caller",
      source: "hint",
    })
  }
  return out
}

export type CheckDeps = {
  explain: ExplainFn
  parseHint: (text: string) => FactInput[]
  connectors?: {
    test: (id: string, task: string) => Promise<ConnectorResult>
  }
}

/**
 * The dry run behind the check command: a hint line or a bare task id becomes
 * facts, configured connectors that match the task are tested, and explain()
 * says what the router would decide. Nothing is dispatched.
 */
export async function checkDecision(
  line: string,
  cfg: RoutingV2Config,
  deps: CheckDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const text = line.trim()
  if (!text) return { ok: false, lines: ["Enter a hint line or a task id."] }
  const head = `check: ${text} (dry run, nothing dispatched)`
  const inputs: FactInput[] = /\[\[|=/.test(text)
    ? deps.parseHint(text)
    : [{ fact: "task", value: text, kind: "caller", source: "check" }]
  const task = inputs.find((i) => i.fact === "task")?.value
  const notes: string[] = []
  let override: { level?: string; detail: string } | undefined

  if (!deps.connectors || cfg.connectors.length === 0)
    notes.push("connectors: not configured")
  else if (typeof task !== "string")
    notes.push("connectors: no task id, none tested")
  else {
    notes.push("connectors:")
    for (const c of cfg.connectors) {
      try {
        if (c.match?.task && !new RegExp(c.match.task).test(task)) continue
      } catch {
        notes.push(`  ${c.id} error bad match.task pattern`)
        continue
      }
      try {
        const r = await deps.connectors.test(c.id, task)
        inputs.push(...r.facts)
        if (r.override) override = r.override
        notes.push(
          `  ${c.id} ${r.ok ? "ok" : "error"} ${r.ms}ms${r.cached ? " cached" : ""}${r.error ? ` ${r.error}` : ""}`,
        )
      } catch (err) {
        notes.push(
          `  ${c.id} error ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (notes.length === 1) notes.push("  none matches this task")
  }

  try {
    const d = deps.explain(
      {
        agent: "check",
        prompt: text,
        inputs,
        ...(override ? { override } : {}),
      },
      cfg,
    )
    return { ok: true, lines: [head, ...v2Lines(d, notes)] }
  } catch (err) {
    return {
      ok: false,
      lines: [
        head,
        `explain failed: ${err instanceof Error ? err.message : String(err)}`,
        ...notes,
      ],
    }
  }
}

// ---- routing v2: settings ----

export type SettingKind = "string" | "number" | "boolean" | "json"

export type SettingRow = {
  title: string
  /** The current value, as shown. */
  shown: string
  /** Where it lives in the config file. */
  path: Path
  kind: SettingKind
  current: unknown
  /** A fixed set of values to pick from instead of typing. */
  choices?: string[]
  /** Text to start a typed edit from. */
  initial: string
  removable: boolean
}

export const SECTIONS = [
  { id: "levels", title: "Levels", description: "level to model" },
  {
    id: "policy",
    title: "Policy",
    description: "risk x difficulty matrix, risk floor, retry step",
  },
  {
    id: "difficulty",
    title: "Difficulty",
    description: "score points and cutoffs",
  },
  { id: "connectors", title: "Connectors", description: "task trackers" },
  { id: "advisor", title: "Advisor", description: "level and implementation" },
  {
    id: "calibration",
    title: "Calibration",
    description: "when a bucket raises a suggestion",
  },
  { id: "mode", title: "Mode", description: "shadow or enforce, v2 on or off" },
] as const
export type SectionId = (typeof SECTIONS)[number]["id"]

const compact = (v: unknown): string => {
  if (v === undefined) return "—"
  const t = typeof v === "string" ? v : JSON.stringify(v)
  return t.length > 70 ? `${t.slice(0, 69)}…` : t
}

const DIFFICULTIES = ["low", "medium", "high"] as const

/** The editable values of one config section, one row each. */
export function settingRows(
  section: SectionId,
  cfg: Pick<Config, "mode" | "v2">,
): SettingRow[] {
  const v2 = cfg.v2
  const row = (
    title: string,
    path: Path,
    kind: SettingKind,
    extra: Partial<SettingRow> = {},
  ): SettingRow => {
    const current = getAt(cfg, path)
    return {
      title,
      shown: compact(current),
      path,
      kind,
      current,
      initial:
        current === undefined
          ? ""
          : typeof current === "string"
            ? current
            : JSON.stringify(current),
      removable: false,
      ...extra,
    }
  }
  const lv = [...v2.levelOrder]
  const rows: SettingRow[] = []
  switch (section) {
    case "levels":
      for (const l of Object.keys(v2.levels))
        rows.push(row(`${l} model`, ["v2", "levels", l, "model"], "string"))
      rows.push(row("order, cheapest first", ["v2", "levelOrder"], "json"))
      break
    case "policy":
      for (const risk of Object.keys(v2.policy.matrix))
        for (const d of DIFFICULTIES)
          rows.push(
            row(
              `matrix ${risk} / ${d}`,
              ["v2", "policy", "matrix", risk, d],
              "string",
              { choices: lv },
            ),
          )
      for (const risk of Object.keys(v2.policy.matrix))
        rows.push(
          row(
            `risk floor ${risk}`,
            ["v2", "policy", "riskFloor", risk],
            "string",
            {
              choices: lv,
              removable: v2.policy.riskFloor[risk as "low"] !== undefined,
            },
          ),
        )
      rows.push(row("retry step", ["v2", "policy", "retryStep"], "number"))
      break
    case "difficulty":
      v2.difficulty.points.forEach((_, i) =>
        rows.push(
          row(`point ${i + 1}`, ["v2", "difficulty", "points", i], "json", {
            removable: true,
          }),
        ),
      )
      rows.push(
        row(
          "+ add a point",
          ["v2", "difficulty", "points", v2.difficulty.points.length],
          "json",
          { initial: '{"fact":"files","gte":10,"add":1}' },
        ),
      )
      rows.push(
        row(
          "cutoff medium",
          ["v2", "difficulty", "cutoffs", "medium"],
          "number",
        ),
        row("cutoff high", ["v2", "difficulty", "cutoffs", "high"], "number"),
      )
      break
    case "connectors":
      v2.connectors.forEach((c, i) =>
        rows.push(
          row(`${c.id}`, ["v2", "connectors", i], "json", {
            removable: true,
            shown: compact({
              match: c.match,
              ...(c.command ? { command: c.command } : { http: c.http?.url }),
              ttlMinutes: c.ttlMinutes,
              rules: c.map.length,
            }),
          }),
        ),
      )
      rows.push(
        row(
          "+ add a connector",
          ["v2", "connectors", v2.connectors.length],
          "json",
          {
            initial:
              '{"id":"github","match":{"task":"^\\\\d+$"},"command":["gh","issue","view","{task}","--json","labels"],"timeoutMs":3000,"ttlMinutes":360,"map":[]}',
          },
        ),
      )
      break
    case "advisor":
      rows.push(
        row("level", ["v2", "advisor", "level"], "string", { choices: lv }),
        row("implementation", ["v2", "advisor", "impl"], "string", {
          choices: ["auto", "native", "tool"],
        }),
      )
      break
    case "calibration":
      rows.push(
        row(
          "min first-pass rate",
          ["v2", "calibration", "minFirstPass"],
          "number",
        ),
        row(
          "min tasks per bucket",
          ["v2", "calibration", "minTasks"],
          "number",
        ),
      )
      break
    case "mode":
      rows.push(
        row("mode", ["mode"], "string", { choices: ["shadow", "enforce"] }),
        row("routing v2", ["v2", "enabled"], "boolean", {
          choices: ["true", "false"],
        }),
      )
      break
  }
  return rows
}

/** Typed text (or a picked choice) to the JSON value to write, or why it will not do. */
export function parseSettingValue(
  kind: SettingKind,
  raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const t = raw.trim()
  if (t === "") return { ok: false, reason: "empty value" }
  switch (kind) {
    case "string":
      return { ok: true, value: t }
    case "number": {
      const n = Number(t)
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, reason: `${JSON.stringify(t)} is not a number` }
    }
    case "boolean":
      return t === "true" || t === "false"
        ? { ok: true, value: t === "true" }
        : { ok: false, reason: "expected true or false" }
    case "json":
      try {
        return { ok: true, value: JSON.parse(t) }
      } catch (err) {
        return {
          ok: false,
          reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
  }
}

// ---- routing v2: calibration ----

type CalBucket = {
  risk: string
  difficulty: string
  level: string
  tasks: number
  firstPass: number
  avgRetries: number
  costPerTask: number | null
}

export type Suggestion = {
  id: string
  kind: "matrix" | "cutoff" | "info"
  path: string
  from: string | number
  to: string | number
  why: string
}

export type CalibrationView = {
  v: 1
  t: string
  window_days: number
  tasks: number
  buckets: CalBucket[]
  backtest: {
    monotonic: boolean
    byDifficulty: Record<
      string,
      { tasks: number; avgRetries: number; costPerTask: number | null }
    >
  }
  suggestions: Suggestion[]
}

/** Where calibration.json is written (the same place the calibrate command uses). */
export function calibrationFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_CALIBRATION)
    return env.OPENCODE_MODEL_ADVISOR_CALIBRATION
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "model-advisor", "calibration.json")
}

/** The file's text as a calibration, or undefined when it is not one. */
export function parseCalibration(text: string): CalibrationView | undefined {
  try {
    const c = JSON.parse(text) as Partial<CalibrationView>
    if (c?.v !== 1 || !Array.isArray(c.buckets)) return undefined
    return {
      v: 1,
      t: String(c.t ?? ""),
      window_days: Number(c.window_days ?? 0),
      tasks: Number(c.tasks ?? 0),
      buckets: c.buckets,
      backtest: {
        monotonic: c.backtest?.monotonic === true,
        byDifficulty: c.backtest?.byDifficulty ?? {},
      },
      suggestions: Array.isArray(c.suggestions) ? c.suggestions : [],
    }
  } catch {
    return undefined
  }
}

/** Null (no known cost) and a missing value both read as a dash. */
const cost = (v: number | null | undefined): string =>
  typeof v === "number" ? money(v) : "—"

export function calibrationReport(c: CalibrationView): string[] {
  const days = Object.entries(c.backtest.byDifficulty)
  return [
    `calibrated ${c.t ? new Date(c.t).toLocaleString() : "?"} · last ${c.window_days} days · ${c.tasks} tasks`,
    `backtest monotonic: ${c.backtest.monotonic ? "yes" : "NO, higher difficulty does not always cost more retries or money"}`,
    ...(days.length > 0
      ? [
          "",
          ...table([
            ["difficulty", "tasks", "retries", "cost/task"],
            ...days.map(([d, s]) => [
              d,
              String(s.tasks),
              String(s.avgRetries),
              cost(s.costPerTask),
            ]),
          ]),
        ]
      : []),
    "",
    ...(c.buckets.length > 0
      ? table([
          [
            "risk",
            "difficulty",
            "level",
            "tasks",
            "first-pass",
            "retries",
            "cost/task",
          ],
          ...c.buckets.map((b) => [
            b.risk,
            b.difficulty,
            b.level,
            String(b.tasks),
            `${Math.round(b.firstPass * 100)}%`,
            String(b.avgRetries),
            cost(b.costPerTask),
          ]),
        ])
      : ["no buckets yet"]),
    "",
    c.suggestions.length > 0
      ? `${c.suggestions.length} suggestion${c.suggestions.length === 1 ? "" : "s"}`
      : "no suggestions",
  ]
}

export type SuggestionOption = {
  title: string
  description: string
  category: string
  value: string
  /** Info suggestions have nothing to change. */
  applicable: boolean
}

export const suggestionOptions = (c: CalibrationView): SuggestionOption[] =>
  c.suggestions.map((s) => ({
    title: s.kind === "info" ? `${s.path}` : `${s.path}: ${s.from} → ${s.to}`,
    description: s.why,
    category: s.kind === "info" ? "For information" : "Apply",
    value: s.id,
    applicable: s.kind !== "info",
  }))

/**
 * The config edit that applies one suggestion, or why it cannot be applied:
 * info suggestions change nothing, and a suggestion whose `from` no longer
 * matches the config was written against a config that has since changed.
 */
export function suggestionEdit(
  s: Suggestion,
  cfg: Pick<Config, "mode" | "v2">,
):
  | { ok: true; path: Path; value: string | number }
  | { ok: false; reason: string } {
  if (s.kind === "info")
    return { ok: false, reason: "informational; nothing to apply" }
  const path = parsePath(s.path)
  if (path[0] !== "v2" || path.length < 2)
    return { ok: false, reason: `${s.path} is not a v2 setting` }
  const now = getAt(cfg, path)
  if (now !== s.from)
    return {
      ok: false,
      reason: `config changed since: ${s.path} is ${compact(now)}, the suggestion expected ${s.from}`,
    }
  if (s.from === s.to) return { ok: false, reason: "nothing to change" }
  return { ok: true, path, value: s.to }
}
