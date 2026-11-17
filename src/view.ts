/**
 * What the TUI shows, as plain functions over the decisions stream: the
 * sidebar panel, the decisions list and the alert toasts. No UI types in here.
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
    why: sourceLabel(d).replace(/^rule:/, ""),
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
  ]
    .filter(Boolean)
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
