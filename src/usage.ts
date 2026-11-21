/**
 * Usage accounting: one row per executor step and per advisor call.
 *
 * Executor rows come from the host's step events, advisor rows from the
 * advisor's own usage entries. The TUI runs in another process, so the two
 * share a file: `usage.jsonl` next to the log. Raw rows are folded into
 * day x provider x model x agent x role aggregates once the file passes 2 MB.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { logPath } from "./logger.ts"
import type { Telemetry } from "./otel.ts"
import { listCostUsd } from "./pricing.ts"

export type Role = "executor" | "advisor"

export type UsageRow = {
  v: 1
  /** Local date, YYYY-MM-DD. */
  day: string
  provider: string
  /** Model id without the provider. */
  model: string
  agent: string
  role: Role
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** Some of the cost is list price because the host reported none. */
  est?: boolean
  /** Shadow mode: USD the router's pick would have saved on this step. */
  wouldSave?: number
  /** Enforce mode: USD the router's pick saved on this step. */
  saved?: number
  sessions: string[]
}

export type UsageWindow = "today" | "7d" | "30d"
export const WINDOWS: UsageWindow[] = ["today", "7d", "30d"]

const MAX_BYTES = 2_000_000
const CHECK_EVERY = 50
const MAX_SESSIONS = 100
const MAX_STEPS = 2000

export function usagePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_USAGE) return env.OPENCODE_MODEL_ADVISOR_USAGE
  return join(dirname(logPath(env)), "usage.jsonl")
}

const pad2 = (n: number) => String(n).padStart(2, "0")

export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const key = (r: UsageRow) =>
  [r.day, r.provider, r.model, r.agent, r.role].join("|")

/** Rows of the same day, provider, model, agent and role become one. */
export function fold(rows: UsageRow[]): UsageRow[] {
  const out = new Map<string, UsageRow>()
  for (const r of rows) {
    const a = out.get(key(r))
    if (!a) {
      out.set(key(r), { ...r, sessions: r.sessions.slice(0, MAX_SESSIONS) })
      continue
    }
    a.requests += r.requests
    a.input += r.input
    a.output += r.output
    a.reasoning += r.reasoning
    a.cacheRead += r.cacheRead
    a.cacheWrite += r.cacheWrite
    a.cost += r.cost
    a.est ||= r.est
    if (r.wouldSave !== undefined)
      a.wouldSave = (a.wouldSave ?? 0) + r.wouldSave
    if (r.saved !== undefined) a.saved = (a.saved ?? 0) + r.saved
    for (const s of r.sessions)
      if (a.sessions.length < MAX_SESSIONS && !a.sessions.includes(s))
        a.sessions.push(s)
  }
  return [...out.values()]
}

export function parseUsage(text: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as UsageRow
      if (
        r?.v === 1 &&
        typeof r.day === "string" &&
        (r.role === "executor" || r.role === "advisor") &&
        Array.isArray(r.sessions)
      )
        out.push(r)
    } catch {}
  }
  return out
}

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

export const readUsage = (path: string = usagePath()): UsageRow[] =>
  parseUsage(readText(path))

const writes = new Map<string, number>()

// shortcut: a row another process appends during the rewrite is lost; upgrade to a lock if that matters.
function compact(path: string): void {
  try {
    if (statSync(path).size <= MAX_BYTES) return
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      fold(readUsage(path))
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    )
    renameSync(tmp, path)
  } catch {}
}

/** Appends one line; never throws. */
export function appendUsage(row: UsageRow, path: string = usagePath()): void {
  try {
    const n = writes.get(path)
    if (n === undefined) {
      mkdirSync(dirname(path), { recursive: true })
      compact(path)
    } else if (n % CHECK_EVERY === 0) compact(path)
    writes.set(path, (n ?? 0) + 1)
    appendFileSync(path, `${JSON.stringify(row)}\n`)
  } catch {}
}

/** Re-reads only when the file changed (one stat per call). */
export class UsageReader {
  private stamp = ""
  private rows: UsageRow[] = []
  private path: () => string

  constructor(path: () => string = () => usagePath()) {
    this.path = path
  }

  read(): UsageRow[] {
    const path = this.path()
    let stamp = "missing"
    try {
      const s = statSync(path)
      stamp = `${path}:${s.mtimeMs}:${s.size}`
    } catch {}
    if (stamp !== this.stamp) {
      this.stamp = stamp
      this.rows = readUsage(path)
    }
    return this.rows
  }
}

/** Rows of the window's days, today included. */
export function inWindow(
  rows: UsageRow[],
  window: UsageWindow,
  now = Date.now(),
): UsageRow[] {
  const from = new Date(now)
  from.setDate(
    from.getDate() - (window === "today" ? 0 : window === "7d" ? 6 : 29),
  )
  const since = dayOf(from.getTime())
  return rows.filter((r) => r.day >= since)
}

export type Total = Pick<
  UsageRow,
  | "requests"
  | "input"
  | "output"
  | "reasoning"
  | "cacheRead"
  | "cacheWrite"
  | "cost"
> & { est: boolean; wouldSave: number; saved: number }

const zero = (): Total => ({
  requests: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  est: false,
  wouldSave: 0,
  saved: 0,
})

export function total(rows: UsageRow[]): Total {
  const t = zero()
  for (const r of rows) {
    t.requests += r.requests
    t.input += r.input
    t.output += r.output
    t.reasoning += r.reasoning
    t.cacheRead += r.cacheRead
    t.cacheWrite += r.cacheWrite
    t.cost += r.cost
    t.est ||= !!r.est
    t.wouldSave += r.wouldSave ?? 0
    t.saved += r.saved ?? 0
  }
  return t
}

export type Line = Total & { model: string; role: Role }

/** One line per model and role, dearest first. */
export function byModel(rows: UsageRow[]): Line[] {
  const groups = new Map<string, UsageRow[]>()
  for (const r of rows) {
    const k = `${r.role}|${r.model}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.values()]
    .map((g) =>
      Object.assign(total(g), { model: g[0]!.model, role: g[0]!.role }),
    )
    .toSorted((a, b) => b.cost - a.cost || b.requests - a.requests)
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0

type StepData = Record<string, any>

/** Remembers each step's model and agent from `session.step.started` until it ends. */
export class StepTracker {
  private steps = new Map<
    string,
    { provider: string; model: string; agent: string }
  >()

  started(data: StepData): void {
    if (!data.assistantMessageID || !data.model?.id) return
    this.steps.set(data.assistantMessageID, {
      provider: String(data.model.providerID ?? "unknown"),
      model: String(data.model.id).replace(/^[\w-]+\//, ""),
      agent: String(data.agent ?? "unknown"),
    })
    if (this.steps.size > MAX_STEPS) {
      const oldest = this.steps.keys().next().value
      if (oldest !== undefined) this.steps.delete(oldest)
    }
  }

  /** The executor row for a finished or failed step; undefined when it carries no tokens. */
  ended(
    data: StepData,
    now: number,
    saving?: { usd: number; shadow: boolean },
  ): UsageRow | undefined {
    const t = data.tokens
    const step = this.steps.get(data.assistantMessageID)
    this.steps.delete(data.assistantMessageID)
    if (!t || typeof data.sessionID !== "string") return undefined
    const model = step?.model ?? "unknown"
    const row: UsageRow = {
      v: 1,
      day: dayOf(now),
      provider: step?.provider ?? "unknown",
      model,
      agent: step?.agent ?? "unknown",
      role: "executor",
      requests: 1,
      input: num(t.input),
      output: num(t.output),
      reasoning: num(t.reasoning),
      cacheRead: num(t.cache?.read),
      cacheWrite: num(t.cache?.write),
      cost: 0,
      sessions: [data.sessionID],
    }
    if (num(data.cost) > 0) row.cost = data.cost
    else {
      // OpenCode reports no cost on a subscription account, so price the tokens at list.
      const priced = listCostUsd(model, {
        input: row.input,
        output: row.output + row.reasoning,
        cache: { read: row.cacheRead, write: row.cacheWrite },
      })
      if (priced !== undefined) {
        row.cost = priced
        row.est = true
      }
    }
    if (saving) {
      if (saving.shadow) row.wouldSave = saving.usd
      else row.saved = saving.usd
    }
    return row
  }
}

export type AdvisorCall = {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The advisor's own cost: it reads the transcript uncached, so list price covers it. */
export const advisorCost = (model: string, c: AdvisorCall): number =>
  listCostUsd(model, {
    input: c.input,
    output: c.output,
    cache: { read: c.cacheRead, write: c.cacheWrite },
  }) ?? 0

export function advisorRow(
  call: AdvisorCall & { model: string; cost: number },
  who: { agent: string; session?: string },
  now: number,
): UsageRow {
  return {
    v: 1,
    day: dayOf(now),
    provider: "anthropic",
    model: call.model.replace(/^[\w-]+\//, ""),
    agent: who.agent,
    role: "advisor",
    requests: 1,
    input: call.input,
    output: call.output,
    reasoning: 0,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    cost: call.cost,
    sessions: who.session ? [who.session] : [],
  }
}

export type Usage = { add(row: UsageRow): void }

/** Writes a row and counts it in the usage metrics. */
export function createUsage(
  telemetry: Telemetry,
  write: (row: UsageRow) => void = appendUsage,
): Usage {
  return {
    add(row) {
      write(row)
      const attrs = { model: row.model, role: row.role, agent: row.agent }
      telemetry.count("model_advisor.usage.requests", attrs, row.requests)
      const kinds = {
        input: row.input,
        output: row.output,
        reasoning: row.reasoning,
        cache_read: row.cacheRead,
        cache_write: row.cacheWrite,
      }
      for (const [kind, n] of Object.entries(kinds))
        if (n > 0)
          telemetry.count("model_advisor.usage.tokens", { ...attrs, kind }, n)
      if (row.cost > 0)
        telemetry.count("model_advisor.usage.cost_usd", attrs, row.cost)
    },
  }
}
