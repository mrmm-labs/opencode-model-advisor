/**
 * What the TUI shows, as plain functions over the decisions stream: sidebar
 * lines, the decisions list and the alert toasts. No UI types in here.
 */
import type {
  AdviceRecord,
  AdvisorRecord,
  AlertRecord,
  DecisionRecord,
} from "./decisions.ts"

const money = (usd: number): string => `$${usd.toFixed(2)}`

const sourceLabel = (d: DecisionRecord): string =>
  d.source === "rule" && d.rule ? `rule:${d.rule}` : d.source

/** `builder→sonnet (would) · rule:read-only`; enforce says `applied`. */
export function decisionText(d: DecisionRecord): string {
  const state = d.mode === "enforce" ? "applied" : "would"
  return `${d.agent}→${d.tier} (${state}) · ${sourceLabel(d)}`
}

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

/**
 * One or two short lines for a session. A routed child shows its own decision;
 * a dispatching session shows its latest ones, and the advisor usage of the
 * session and the children it dispatched.
 */
export function sidebarLines(
  records: AdvisorRecord[],
  session: string,
): string[] {
  const ix = index(records)
  const own = ix.links.get(session)
  const family = new Set([session])
  for (const [child, parent] of ix.parents)
    if (parent === session) family.add(child)
  const advice = adviceText(adviceFor(ix, family))

  const lines: string[] = []
  const owned = own ? ix.decisions.get(own) : undefined
  if (owned) lines.push(`router ${owned.mode} · ${decisionText(owned)}`)
  else {
    const mine = [...ix.decisions.values()].filter((d) => d.session === session)
    const last = mine.slice(-2)
    if (last.length) {
      const mode = last[last.length - 1].mode
      const rest = mine.length - last.length
      lines.push(
        `router ${mode} · ${last.map(decisionText).join(" | ")}${rest > 0 ? ` +${rest}` : ""}`,
      )
    }
  }
  if (advice) lines.push(advice)
  return lines
}

export type DecisionRow = {
  title: string
  description: string
  value: string
}

const p = (n: number) => String(n).padStart(2, "0")

const clock = (iso: string): string => {
  const d = new Date(iso)
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The newest `limit` decisions, newest first. */
export function decisionRows(
  records: AdvisorRecord[],
  limit = 20,
): DecisionRow[] {
  const ix = index(records)
  const childOf = new Map<string, string>()
  for (const [child, id] of ix.links) childOf.set(id, child)
  return [...ix.decisions.values()]
    .slice(-limit)
    .toReversed()
    .map((d) => {
      const child = childOf.get(d.id)
      const advice = child
        ? adviceText(adviceFor(ix, new Set([child])))
        : undefined
      const parts = [
        d.mode,
        `applied ${d.model}`,
        `would ${d.would}`,
        sourceLabel(d),
        d.reason,
        ...(advice ? [advice] : []),
      ]
      return {
        title: `${clock(d.t)} ${d.agent} → ${d.tier}`,
        description: parts.join(" · "),
        value: d.id,
      }
    })
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
