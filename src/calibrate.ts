/**
 * Automatic calibration (docs/spec-routing-v2.md section 7, docs/calibration.md).
 *
 * Reads the decisions log and OpenCode's session store, groups dispatches into tasks, and
 * reports how often each risk × difficulty × level bucket got it right first time. It only
 * suggests config changes; it never edits the config.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  appendRecord,
  decisionsPath,
  readRecords,
  type AdvisorRecord,
  type DecisionRecord,
} from "./decisions.ts"
import { scoreDifficulty } from "./explain.ts"
import type {
  Difficulty,
  Facts,
  Risk,
  RoutingV2Config,
  ScoreFn,
} from "./route-v2.ts"

const DAY_MS = 86_400_000
const DIFFICULTIES: Difficulty[] = ["low", "medium", "high"]
const RISKS: Risk[] = ["low", "medium", "high", "critical"]
const UNUSED_DAYS = 30
const CHUNK = 500

export type Bucket = {
  risk: Risk
  difficulty: Difficulty
  level: string
  tasks: number
  firstPass: number
  avgRetries: number
  /** Null when no task of the bucket has a known cost. */
  costPerTask: number | null
}

export type DifficultyStat = {
  tasks: number
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

export type Calibration = {
  v: 1
  t: string
  window_days: number
  tasks: number
  buckets: Bucket[]
  backtest: {
    monotonic: boolean
    byDifficulty: Record<Difficulty, DifficultyStat>
  }
  suggestions: Suggestion[]
}

export type TaskStat = {
  task: string
  risk: Risk
  difficulty: Difficulty
  level: string
  retries: number
  firstPass: boolean
  cost: number | null
}

export function calibrationPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_CALIBRATION)
    return env.OPENCODE_MODEL_ADVISOR_CALIBRATION
  return join(dataHome(env), "opencode", "model-advisor", "calibration.json")
}

const dataHome = (env: NodeJS.ProcessEnv): string =>
  env.XDG_DATA_HOME || join(homedir(), ".local", "share")

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_DB || join(dataHome(env), "opencode", "opencode.db")
}

/** Cost per child session, read-only. Undefined when the store or table is unavailable. */
export async function readCosts(
  path: string,
  sessions: string[],
): Promise<Map<string, number> | undefined> {
  try {
    statSync(path)
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const out = new Map<string, number>()
      for (let i = 0; i < sessions.length; i += CHUNK) {
        const ids = sessions.slice(i, i + CHUNK)
        const rows = db
          .prepare(
            `SELECT id, cost FROM session_v2 WHERE id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as { id: string; cost: number | null }[]
        for (const r of rows)
          if (typeof r.cost === "number") out.set(r.id, r.cost)
      }
      return out
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

type Loose = DecisionRecord & { files?: number; retry?: number }

const V1_RISK: Record<string, Risk> = {
  haiku: "low",
  sonnet: "medium",
  opus: "high",
}

const isRisk = (v: unknown): v is Risk => RISKS.includes(v as Risk)

const levelOf = (d: DecisionRecord): string => d.v2?.level ?? d.tier

const riskOf = (d: DecisionRecord, cfg: RoutingV2Config): Risk => {
  const r = d.v2 ? (d.v2.risk ?? d.v2.facts.risk?.value) : undefined
  if (isRisk(r)) return r
  return V1_RISK[d.tier] ?? (isRisk(d.tier) ? d.tier : cfg.defaults.risk)
}

const retryOf = (d: DecisionRecord): number => {
  const r = d.v2 ? d.v2.facts.retry?.value : (d as Loose).retry
  return typeof r === "number" ? r : 0
}

const v1Facts = (d: Loose, risk: Risk): Facts => {
  const facts: Facts = {}
  const put = (name: keyof Facts, value: string | number) => {
    facts[name] = { value, kind: "derived", source: "v1", others: [] }
  }
  if (d.task) put("task", d.task)
  put("risk", risk)
  if (typeof d.files === "number") put("files", d.files)
  if (typeof d.retry === "number") put("retry", d.retry)
  return facts
}

const taskOf = (d: DecisionRecord): string | undefined => {
  if (d.task) return d.task
  const t = d.v2?.facts.task?.value
  return typeof t === "string" || typeof t === "number" ? String(t) : undefined
}

/** Child sessions linked to each decision id. */
export function linkedSessions(
  records: AdvisorRecord[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of records) {
    if (r.kind !== "link") continue
    const list = out.get(r.decision) ?? []
    list.push(r.session)
    out.set(r.decision, list)
  }
  return out
}

/**
 * One entry per task seen in the window. Difficulty, risk and level come from the task's first
 * dispatch (the routing the matrix decided; retries step up from it). A task is first-pass when
 * no agent was dispatched twice and no retry fact was above zero.
 */
export function collectTasks(
  records: AdvisorRecord[],
  costs: Map<string, number> | undefined,
  cfg: RoutingV2Config,
  opts: { sinceMs?: number; score?: ScoreFn } = {},
): TaskStat[] {
  const score = opts.score ?? scoreDifficulty
  const links = linkedSessions(records)
  const byTask = new Map<string, DecisionRecord[]>()
  for (const r of records) {
    if (r.kind !== "decision") continue
    if (opts.sinceMs !== undefined && Date.parse(r.t) < opts.sinceMs) continue
    const task = taskOf(r)
    if (!task) continue
    const list = byTask.get(task) ?? []
    list.push(r)
    byTask.set(task, list)
  }
  const out: TaskStat[] = []
  for (const [task, list] of byTask) {
    list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    const first = list[0]!
    const risk = riskOf(first, cfg)
    const facts = first.v2?.facts ?? v1Facts(first as Loose, risk)
    const perAgent = new Map<string, number>()
    for (const d of list)
      perAgent.set(d.agent, (perAgent.get(d.agent) ?? 0) + 1)
    const extra = Math.max(...[...perAgent.values()].map((n) => n - 1))
    const retries = Math.max(extra, ...list.map(retryOf))
    let cost: number | null = null
    if (costs)
      for (const d of list)
        for (const s of links.get(d.id) ?? []) {
          const c = costs.get(s)
          if (c !== undefined) cost = (cost ?? 0) + c
        }
    out.push({
      task,
      risk,
      difficulty: score(facts, cfg).difficulty,
      level: levelOf(first),
      retries,
      firstPass: retries === 0,
      cost,
    })
  }
  return out
}

const round = (n: number, p = 4): number => Math.round(n * 10 ** p) / 10 ** p

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

/** Average cost over the tasks that have one; null when none do. */
const meanCost = (tasks: TaskStat[]): number | null => {
  const known = tasks.flatMap((t) => (t.cost === null ? [] : [t.cost]))
  return known.length ? round(mean(known), 6) : null
}

export function buildBuckets(tasks: TaskStat[]): Bucket[] {
  const groups = new Map<string, TaskStat[]>()
  for (const t of tasks) {
    const key = `${t.risk}\0${t.difficulty}\0${t.level}`
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const order = (b: Bucket) =>
    RISKS.indexOf(b.risk) * 3 + DIFFICULTIES.indexOf(b.difficulty)
  return [...groups.values()]
    .map((g) => ({
      risk: g[0]!.risk,
      difficulty: g[0]!.difficulty,
      level: g[0]!.level,
      tasks: g.length,
      firstPass: round(mean(g.map((t) => (t.firstPass ? 1 : 0)))),
      avgRetries: round(mean(g.map((t) => t.retries))),
      costPerTask: meanCost(g),
    }))
    .sort((a, b) => order(a) - order(b) || a.level.localeCompare(b.level))
}

export function backtest(
  tasks: TaskStat[],
  minTasks: number,
): Calibration["backtest"] {
  const byDifficulty = {} as Record<Difficulty, DifficultyStat>
  for (const d of DIFFICULTIES) {
    const g = tasks.filter((t) => t.difficulty === d)
    byDifficulty[d] = {
      tasks: g.length,
      avgRetries: round(mean(g.map((t) => t.retries))),
      costPerTask: meanCost(g),
    }
  }
  return {
    monotonic: violations(byDifficulty, minTasks).length === 0,
    byDifficulty,
  }
}

type Violation = { lower: Difficulty; upper: Difficulty; metric: string }

/** Adjacent pairs among buckets with enough tasks where the harder one looks easier. */
function violations(
  by: Record<Difficulty, DifficultyStat>,
  minTasks: number,
): Violation[] {
  const eligible = DIFFICULTIES.filter((d) => by[d].tasks >= minTasks)
  const out: Violation[] = []
  for (let i = 1; i < eligible.length; i++) {
    const lower = eligible[i - 1]!
    const upper = eligible[i]!
    const a = by[lower]
    const b = by[upper]
    if (b.avgRetries < a.avgRetries)
      out.push({ lower, upper, metric: "retries" })
    else if (
      a.costPerTask !== null &&
      b.costPerTask !== null &&
      b.costPerTask < a.costPerTask
    )
      out.push({ lower, upper, metric: "cost" })
  }
  return out
}

/**
 * Cutoff heuristic: when a lower bucket does worse than the one above it, it holds tasks that are
 * harder than scored, so the upper bucket's cutoff drops by one point (never below 1, and
 * `high` stays above `medium`) to pull the hardest of them up.
 */
function cutoffSuggestions(
  by: Record<Difficulty, DifficultyStat>,
  cfg: RoutingV2Config,
): Suggestion[] {
  const out: Suggestion[] = []
  for (const v of violations(by, cfg.calibration.minTasks)) {
    if (v.upper === "low") continue
    const cut = v.upper
    const from = cfg.difficulty.cutoffs[cut]
    const floor = cut === "high" ? cfg.difficulty.cutoffs.medium + 1 : 1
    const to = Math.max(from - 1, floor)
    if (to === from) continue
    out.push({
      id: `cutoff:${cut}`,
      kind: "cutoff",
      path: `v2.difficulty.cutoffs.${cut}`,
      from,
      to,
      why: `${v.lower} difficulty has more ${v.metric} than ${v.upper} (${describe(by[v.lower], by[v.upper], v.metric)}); lower the ${cut} cutoff so harder tasks score ${cut}`,
    })
  }
  return out
}

const describe = (a: DifficultyStat, b: DifficultyStat, metric: string) =>
  metric === "retries"
    ? `${a.avgRetries} vs ${b.avgRetries}`
    : `${a.costPerTask} vs ${b.costPerTask}`

function matrixSuggestions(
  buckets: Bucket[],
  cfg: RoutingV2Config,
): Suggestion[] {
  const order = cfg.levelOrder
  const out: Suggestion[] = []
  for (const b of buckets) {
    if (b.tasks < cfg.calibration.minTasks) continue
    if (b.firstPass >= cfg.calibration.minFirstPass) continue
    const at = order.indexOf(b.level)
    const next = order[at + 1]
    if (at < 0 || next === undefined) continue
    const current = cfg.policy.matrix[b.risk]?.[b.difficulty]
    if (current !== undefined && order.indexOf(current) > at) continue
    out.push({
      id: `matrix:${b.risk}.${b.difficulty}.${b.level}`,
      kind: "matrix",
      path: `v2.policy.matrix.${b.risk}.${b.difficulty}`,
      from: b.level,
      to: next,
      why: `first-pass ${Math.round(b.firstPass * 100)}% over ${b.tasks} tasks, under ${Math.round(cfg.calibration.minFirstPass * 100)}%`,
    })
  }
  return out
}

function unusedLevels(
  records: AdvisorRecord[],
  cfg: RoutingV2Config,
  now: number,
): Suggestion[] {
  const recent = records.filter(
    (r): r is DecisionRecord =>
      r.kind === "decision" &&
      !!r.v2 &&
      Date.parse(r.t) >= now - UNUSED_DAYS * DAY_MS,
  )
  if (!recent.length) return []
  const used = new Set(recent.map((r) => r.v2!.level))
  return cfg.levelOrder
    .filter((l) => !used.has(l))
    .map((l) => ({
      id: `unused:${l}`,
      kind: "info" as const,
      path: `v2.levels.${l}`,
      from: l,
      to: l,
      why: `level never chosen in ${UNUSED_DAYS} days (${recent.length} decisions)`,
    }))
}

export function computeCalibration(
  records: AdvisorRecord[],
  costs: Map<string, number> | undefined,
  cfg: RoutingV2Config,
  opts: { days?: number; now?: number; score?: ScoreFn } = {},
): Calibration {
  const days = opts.days ?? 30
  const now = opts.now ?? Date.now()
  const tasks = collectTasks(records, costs, cfg, {
    sinceMs: now - days * DAY_MS,
    score: opts.score,
  })
  const buckets = buildBuckets(tasks)
  const bt = backtest(tasks, cfg.calibration.minTasks)
  return {
    v: 1,
    t: new Date(now).toISOString(),
    window_days: days,
    tasks: tasks.length,
    buckets,
    backtest: bt,
    suggestions: [
      ...matrixSuggestions(buckets, cfg),
      ...cutoffSuggestions(bt.byDifficulty, cfg),
      ...unusedLevels(records, cfg, now),
    ],
  }
}

export function writeCalibration(c: Calibration, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`)
  renameSync(tmp, path)
}

export function readCalibration(
  path: string = calibrationPath(),
): Calibration | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Calibration
  } catch {
    return undefined
  }
}

export type RunOptions = {
  cfg: RoutingV2Config
  days?: number
  now?: number
  score?: ScoreFn
  decisions?: string
  db?: string
  out?: string
  /** Where the alert record goes; defaults to the decisions log. */
  alerts?: string
}

/** Reads the inputs, writes the calibration file, and raises one alert when there is something to apply. */
export async function runCalibration(opts: RunOptions): Promise<Calibration> {
  const records = readRecords(opts.decisions ?? decisionsPath())
  const sessions = [
    ...new Set(records.flatMap((r) => (r.kind === "link" ? [r.session] : []))),
  ]
  const costs = await readCosts(opts.db ?? dbPath(), sessions)
  const c = computeCalibration(records, costs, opts.cfg, opts)
  writeCalibration(c, opts.out ?? calibrationPath())
  const actionable = c.suggestions.filter((s) => s.kind !== "info")
  if (actionable.length)
    appendRecord(
      {
        v: 1,
        kind: "alert",
        t: c.t,
        alert: "calibration",
        detail:
          `${actionable.length} suggestion(s): ${actionable.map((s) => s.id).join(", ")}`.slice(
            0,
            200,
          ),
      },
      opts.alerts ?? decisionsPath(),
    )
  return c
}

export type Schedule = {
  label: string
  /** Full command: executable then arguments. */
  command: string[]
  hour: number
  minute: number
  logFile: string
}

export const SCHEDULE_LABEL = "dev.opencode-model-advisor.calibrate"

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function launchdPlist(s: Schedule): string {
  const args = s.command.map((a) => `    <string>${xml(a)}</string>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${s.hour}</integer>
    <key>Minute</key>
    <integer>${s.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.logFile)}</string>
</dict>
</plist>
`
}

const shellQuote = (a: string): string =>
  /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`

export function crontabLine(s: Schedule): string {
  return `${s.minute} ${s.hour} * * * ${s.command.map(shellQuote).join(" ")} >> ${shellQuote(s.logFile)} 2>&1`
}
