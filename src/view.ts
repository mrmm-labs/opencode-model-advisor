/**
 * What the TUI shows, as plain functions over the decisions stream: the
 * sidebar panel, the decisions list and the alert toasts. No UI types in here.
 */
import { basename } from "node:path"

import { calibrationPath } from "./calibrate.ts"

import { getAt, parsePath, type Path } from "./config-edit.ts"
import type { Config } from "./config.ts"
import { inputPrice } from "./pricing.ts"
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
    return `Advisor consulted ${t.calls} time${t.calls === 1 ? "" : "s"} (${money(t.cost)})`
  if (t.refused) return "Advisor was refused"
  if (t.would) return "Advisor would have been attached"
  return undefined
}

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

const panelRow = (
  d: DecisionRecord,
  labels?: Record<string, string>,
): PanelRow => {
  const ran = prettyModel(d.model)
  const would = prettyModel(d.would)
  return {
    agent: d.agent,
    models: ran === would ? ran : `${ran} → ${would}`,
    why: whyText(d, labels),
    changed: modelName(d.model) !== modelName(d.would),
  }
}

/** A session's own decisions (its routing if a routed child, else what it dispatched) and the sessions whose advice counts for it. */
function scope(ix: Index, session: string) {
  const family = new Set([session])
  for (const [child, parent] of ix.parents)
    if (parent === session) family.add(child)
  const own = ix.links.get(session)
  const owned = own ? ix.decisions.get(own) : undefined
  const mine = owned
    ? [owned]
    : [...ix.decisions.values()].filter((d) => d.session === session)
  return { family, mine }
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
  labels?: Record<string, string>,
): Panel | undefined {
  const ix = index(records)
  const { family, mine } = scope(ix, session)
  const advice = adviceText(adviceFor(ix, family))
  if (mine.length === 0 && !advice) return undefined
  const shown = mine.slice(-limit).toReversed()
  return {
    mode: mine.at(-1)?.mode ?? "shadow",
    rows: shown.map((d) => panelRow(d, labels)),
    more: mine.length - shown.length,
    ...(advice ? { advice } : {}),
  }
}

export type Tone = "good" | "changed" | "muted"

export type CompactRow = {
  /** Dim, fixed width. */
  label: string
  value: string
  tone?: Tone
}

export type CompactPanel = { mode: string; rows: CompactRow[] }

export const COMPACT_LABEL_WIDTH = 11
/** Usable columns in OpenCode's session sidebar (42 less its padding). */
export const COMPACT_WIDTH = 38

const MODE_WORDS: Record<string, string> = {
  shadow: "watching only",
  enforce: "choosing models",
}

/** `shadow` -> "watching only". */
export const modeText = (mode: string): string => MODE_WORDS[mode] ?? mode

/** `anthropic/claude-sonnet-5-5` -> `sonnet-5-5`, the id without provider or vendor prefix. */
export const modelName = (id: string): string =>
  id.replace(/^[\w-]+\//, "").replace(/^claude-/, "")

/** `claude-opus-5-5` -> "opus 5.5"; an id of another shape is kept as is. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(
    id.replace(/^[\w-]+\//, ""),
  )
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : modelName(id)
}

const RULE_WORDS: Record<string, string> = {
  critical: "marked critical",
  "risky-area": "touches auth / security",
  big: "15+ files",
  "review-security": "security review",
  "read-only": "read-only agent",
}

/** Rule id -> the `label` the config gives it. */
export const ruleLabels = (
  cfg: Pick<Config, "rules">,
): Record<string, string> =>
  Object.fromEntries(
    cfg.rules.flatMap((r) => (r.label ? [[r.id, r.label]] : [])),
  )

/**
 * Why the router picked what it did, as a short phrase: the rule's own label,
 * else a built-in sentence for the stock rules and sources, else the id.
 * `room` is the width it must fit; a v2 reason shortens itself to it.
 */
export function whyText(
  d: DecisionRecord,
  labels: Record<string, string> = {},
  room = Infinity,
): string {
  const rule = d.rule && (labels[d.rule] ?? RULE_WORDS[d.rule])
  if (rule) return rule
  switch (d.source) {
    case "rule":
      return d.rule ? d.rule.replace(/[-_]+/g, " ") : "matched a rule"
    case "default":
      return "no rule matched"
    case "escalation":
      return "retry after a failure"
    case "judge":
      return "judged by the advisor"
    case "judge-failed":
      return "judge failed, default used"
    case "pin":
      return "pinned by you"
    case "override":
      return "asked for in the prompt"
    case "v2": {
      if (!d.v2) return "routing v2"
      if (d.v2.steps.some((s) => s.startsWith("retry")))
        return "retry after a failure"
      const long = `${d.v2.risk} risk, ${d.v2.score.difficulty} difficulty`
      return long.length <= room
        ? long
        : `${d.v2.risk} risk, ${d.v2.score.difficulty} effort`
    }
    default:
      return d.source
  }
}

function direction(
  ran: string,
  would: string,
): "cheaper" | "stronger" | "different" {
  const a = inputPrice(ran)
  const w = inputPrice(would)
  if (a === undefined || w === undefined || a === w) return "different"
  return w > a ? "stronger" : "cheaper"
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.max(n - 1, 1))}…` : s

const usdShort = (usd: number): string =>
  usd >= 10 ? `$${Math.round(usd)}` : money(usd)

/** "would save ≈ $12" in shadow mode, "saved ≈ $12" in enforce mode; a net loss says what it would cost. */
export function todayText(net: number, shadow: boolean): string {
  const sum = usdShort(Math.abs(net))
  return net > 0
    ? `${shadow ? "would save" : "saved"} ≈ ${sum}`
    : `${shadow ? "would cost" : "cost"} ≈ ${sum} more`
}

/** Net estimated saving of the steps since local midnight, or undefined when there are none. */
function savedToday(records: AdvisorRecord[], now: number): number | undefined {
  const start = new Date(now).setHours(0, 0, 0, 0)
  let net: number | undefined
  for (const r of records)
    if (r.kind === "saving" && Date.parse(r.t) >= start)
      net = (net ?? 0) + r.usd
  return net
}

/**
 * The compact sidebar section for one session, in plain words: the last task
 * and the model it ran on, why the router chose what it did, what it suggests
 * when that differs, and today's estimated saving. A row with no data is left
 * out. Undefined when the session has no decision.
 */
export function compactPanel(
  records: AdvisorRecord[],
  session: string,
  opts: { now?: number; width?: number; labels?: Record<string, string> } = {},
): CompactPanel | undefined {
  const { now = Date.now(), width = COMPACT_WIDTH, labels } = opts
  const { mine } = scope(index(records), session)
  const last = mine.at(-1)
  if (!last) return undefined
  const room = width - 2 - COMPACT_LABEL_WIDTH
  const pad = (label: string) => label.padEnd(COMPACT_LABEL_WIDTH)
  const ran = prettyModel(last.model)
  const agent = clip(last.agent, Math.max(room - ran.length - 3, 4))
  const rows: CompactRow[] = [
    { label: pad("Last task"), value: clip(`${agent} · ${ran}`, room) },
    {
      label: pad("Why"),
      value: clip(whyText(last, labels, room), room),
    },
  ]
  if (modelName(last.model) !== modelName(last.would)) {
    const dir = direction(last.model, last.would)
    rows.push({
      label: pad("Suggested"),
      value: clip(`${prettyModel(last.would)} — ${dir}`, room),
      tone:
        dir === "cheaper" ? "good" : dir === "stronger" ? "changed" : "muted",
    })
  }
  const net = savedToday(records, now)
  if (net !== undefined && Math.abs(net) >= 0.005)
    rows.push({
      label: pad("Today"),
      value: clip(todayText(net, last.mode !== "enforce"), room),
      tone: net > 0 ? "good" : "changed",
    })
  return { mode: last.mode, rows }
}

/**
 * The whole verbose block for a session as dialog text, in the compact view's
 * words: every decision, today's saving, then advisor usage.
 */
export function sessionLines(
  records: AdvisorRecord[],
  session: string,
  labels?: Record<string, string>,
  now = Date.now(),
): string[] {
  const panel = routerPanel(records, session, Infinity, labels)
  if (!panel) return ["Nothing routed for this session yet."]
  const net = savedToday(records, now)
  return [
    `The router is ${modeText(panel.mode)}`,
    "",
    ...panel.rows.flatMap((r) => [`${r.agent}  ${r.models}`, `  ${r.why}`]),
    ...(net !== undefined && Math.abs(net) >= 0.005
      ? ["", `Today: ${todayText(net, panel.mode !== "enforce")}`]
      : []),
    ...(panel.advice ? ["", panel.advice] : []),
    "",
    "Ids and the full reason of each decision: /advisor decisions",
  ]
}

/** A rule as a sentence: its label, else the built-in one, else its id in words. */
export const ruleSentence = (
  id: string,
  labels: Record<string, string> = {},
): string => labels[id] ?? RULE_WORDS[id] ?? id.replace(/[-_]+/g, " ")

export function rulesLines(
  cfg: Pick<Config, "mode" | "default" | "pins" | "rules" | "tiers">,
): string[] {
  const pins = Object.entries(cfg.pins)
  const model = (tier: string) =>
    cfg.tiers[tier] ? prettyModel(cfg.tiers[tier]) : tier
  const labels = ruleLabels(cfg)
  return [
    `The router is ${modeText(cfg.mode)}. With no rule or pin it uses ${model(cfg.default)}.`,
    "",
    cfg.rules.length > 0 ? "Rules:" : "No rules.",
    ...cfg.rules.map(
      (r) =>
        `  ${ruleSentence(r.id, labels)} → ${model(r.tier)}   (rule ${r.id}, tier ${r.tier})`,
    ),
    ...(pins.length > 0
      ? [
          "",
          "Pins:",
          ...pins.map(
            ([k, tier]) => `  ${k} → ${model(tier)}   (tier ${tier})`,
          ),
        ]
      : []),
  ]
}

/** What the alert toasts need from the config. */
export const alertContextOf = (
  cfg: Pick<Config, "log" | "ladder" | "v2" | "rules">,
): AlertContext => ({
  summary: cfg.log.summary,
  labels: ruleLabels(cfg),
  top: [cfg.ladder.at(-1), cfg.v2.levelOrder.at(-1)].filter(
    (t): t is string => !!t,
  ),
})

/**
 * The newest `limit` alerts, newest first, each as its time and title, what
 * the agent was doing and what the router did, then a `details` line with the
 * raw reason.
 */
export function alertLines(
  records: AdvisorRecord[],
  limit = 20,
  ctx: AlertContext = {},
): string[] {
  const lines: string[] = []
  const recent = records
    .filter((r): r is AlertRecord => r.kind === "alert")
    .slice(-limit)
    .toReversed()
  for (const a of recent) {
    const n = alertNotice(a, records, ctx)
    lines.push(`${clock(a.t)}  ${n.title.replace(/^Model router · /, "")}`)
    for (const l of n.message.split("\n")) lines.push(`       ${l}`)
    if (a.detail) lines.push(`       details: ${a.detail}`)
  }
  return lines.length > 0 ? lines : ["No alerts yet."]
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
 * (`19:05  general  sonnet 5.5 → opus 5.5`) with the reason in words as description,
 * grouped into those the router would change and those it would keep.
 */
export function decisionRows(
  records: AdvisorRecord[],
  limit = 20,
  labels?: Record<string, string>,
): DecisionRow[] {
  const ix = index(records)
  const childOf = new Map<string, string>()
  for (const [child, id] of ix.links) childOf.set(id, child)
  const recent = [...ix.decisions.values()].slice(-limit).toReversed()
  const width = Math.min(16, Math.max(5, ...recent.map((d) => d.agent.length)))
  const rows = recent.map((d) => {
    const row = panelRow(d, labels)
    const child = childOf.get(d.id)
    const advice = child
      ? adviceText(adviceFor(ix, new Set([child])))
      : undefined
    return {
      title: `${clock(d.t)}  ${fit(d.agent, width)}  ${row.models}`,
      description: [row.why, d.task && `task ${d.task}`, d.summary, advice]
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

/**
 * One decision in words (what ran, what the router picks, why, the task), then
 * a `Details` block with the raw ids, reason and v2 breakdown for debugging.
 */
export function decisionDetail(
  records: AdvisorRecord[],
  id: string,
  labels?: Record<string, string>,
): string | undefined {
  const d = index(records).decisions.get(id)
  if (!d) return undefined
  const ran = prettyModel(d.model)
  const would = prettyModel(d.would)
  const same = modelName(d.model) === modelName(d.would)
  return [
    d.mode === "enforce"
      ? `${d.agent} ran ${ran}${same ? "" : `; the router picked ${would}`}`
      : `${d.agent} ran ${ran}; the router ${same ? "agrees" : `would pick ${would}`}`,
    `Why: ${whyText(d, labels)}`,
    ...(d.task || d.summary
      ? [`Task: ${[d.task, d.summary].filter(Boolean).join(" — ")}`]
      : []),
    `When: ${new Date(d.t).toLocaleString()}`,
    "",
    "Details:",
    `models: ${d.model} (ran), ${d.would} (router)`,
    `why: ${sourceLabel(d)}: ${d.reason}`,
    ...(d.v2 ? ["", ...v2Lines(d.v2)] : []),
  ].join("\n")
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

/** The decision an alert is about: the one it names, else the dispatcher's latest of that agent before it. */
function alertDecision(
  a: AlertRecord,
  records: AdvisorRecord[],
): DecisionRecord | undefined {
  const ix = index(records)
  if (a.decision) return ix.decisions.get(a.decision)
  return [...ix.decisions.values()].findLast(
    (d) => d.session === a.session && d.agent === a.agent && d.t <= a.t,
  )
}

/**
 * The session an alert's toast should open: the subagent session the decision
 * routed if it exists yet, else the dispatching session.
 */
export function alertTarget(
  a: AlertRecord,
  records: AdvisorRecord[],
): string | undefined {
  const id = alertDecision(a, records)?.id
  const child = id
    ? records.findLast((r) => r.kind === "link" && r.decision === id)
    : undefined
  return (child?.kind === "link" ? child.session : undefined) ?? a.session
}

export type AlertContext = {
  /** False when the config turned task summaries off: records that still carry one are not shown. */
  summary?: boolean
  /** The dispatching session, as the host knows it. */
  session?: { title?: string; directory?: string }
  /** Rule id -> label, for the reason. */
  labels?: Record<string, string>
  /** Tier and level names that are the top of their ladder. */
  top?: string[]
}

const ALERT_TITLES: Record<string, (agent: string) => string> = {
  "second-failure": (a) => `${a} failed twice`,
  "fact-disagreement": (a) => `facts disagree for ${a}`,
  "judge-failed": () => "judge failing",
  "advisor-refused": (a) => `advisor refused ${a}`,
  "long-turn-no-advisor": (a) => `${a} ran long without the advisor`,
  calibration: () => "calibration has suggestions",
}

/** What the router did about it, in a sentence; the raw reason stays in the /advisor detail. */
function alertAction(
  a: AlertRecord,
  d: DecisionRecord | undefined,
  top: string[],
): string | undefined {
  switch (a.alert) {
    case "second-failure": {
      if (!d) return undefined
      const model = prettyModel(d.would)
      if (d.reason.includes("stop climbing"))
        return `${d.mode === "enforce" ? "Holding" : "Would hold"} on ${model}, not climbing further`
      const strongest = top.includes(d.tier) ? " (strongest)" : ""
      return `${d.mode === "enforce" ? "Retrying" : "Would retry"} on ${model}${strongest}`
    }
    case "fact-disagreement": {
      const m = /^(\w+): .* → (.+?)(?:;|$)/.exec(a.detail ?? "")
      return m
        ? `Sources disagree on ${m[1]}; the router used ${m[2]}`
        : "Sources disagree on a fact"
    }
    case "judge-failed":
      return "The judge failed; the default tier was used"
    default:
      return a.detail
  }
}

/**
 * The toast for an alert: a title naming the agent, the session and project,
 * what the agent was doing, and what the router did. `sessionID` is where the
 * host offers to open it.
 */
export function alertNotice(
  a: AlertRecord,
  records: AdvisorRecord[],
  ctx: AlertContext = {},
): {
  title: string
  message: string
  variant: "warning" | "error"
  sessionID?: string
} {
  const d = alertDecision(a, records)
  const agent = a.agent ?? "a subagent"
  const where = [
    ctx.session?.title,
    ctx.session?.directory && basename(ctx.session.directory),
  ].filter(Boolean)
  const doing =
    (ctx.summary === false ? undefined : d?.summary) ??
    (a.task ? `task ${a.task}` : undefined)
  const message = [
    where.join(" · "),
    doing && clip(doing, 80),
    alertAction(a, d, ctx.top ?? []),
  ]
    .filter(Boolean)
    .join("\n")
  const target = alertTarget(a, records)
  return {
    title: `Model router · ${(ALERT_TITLES[a.alert] ?? (() => a.alert.replace(/-/g, " ")))(agent)}`,
    message: message || a.alert,
    variant: a.alert === "advisor-refused" ? "error" : "warning",
    ...(target ? { sessionID: target } : {}),
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
  {
    id: "privacy",
    title: "Privacy",
    description: "task summary in the decisions file",
  },
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
  cfg: Pick<Config, "mode" | "v2" | "log">,
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
    case "privacy":
      rows.push(
        row("task summary", ["log", "summary"], "boolean", {
          choices: ["true", "false"],
        }),
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
export const calibrationFile = calibrationPath

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

export function calibrationReport(
  c: CalibrationView,
  levels: Record<string, { model: string }> = {},
): string[] {
  const level = (l: string) =>
    levels[l] ? `${l} (${prettyModel(levels[l].model)})` : l
  const days = Object.entries(c.backtest.byDifficulty)
  return [
    `calibrated ${c.t ? new Date(c.t).toLocaleString() : "?"} · last ${c.window_days} days · ${c.tasks} tasks`,
    `backtest monotonic: ${c.backtest.monotonic ? "yes" : "NO, higher difficulty does not always cost more retries or money"}`,
    ...(days.length > 0
      ? [
          "",
          ...table([
            ["difficulty", "tasks", "retries", "cost per task"],
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
            "first try ok",
            "retries",
            "cost per task",
          ],
          ...c.buckets.map((b) => [
            b.risk,
            b.difficulty,
            level(b.level),
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

/** A suggestion as a sentence; the config path stays in the description. */
export function suggestionTitle(s: Suggestion): string {
  const matrix = /^v2\.policy\.matrix\.(\w+)\.(\w+)$/.exec(s.path)
  if (s.kind === "matrix" && matrix)
    return `For ${matrix[1]} risk, ${matrix[2]} difficulty: use ${s.to} instead of ${s.from}`
  const cutoff = /^v2\.difficulty\.cutoffs\.(\w+)$/.exec(s.path)
  if (s.kind === "cutoff" && cutoff)
    return `Call a task ${cutoff[1]} difficulty from score ${s.to} (now ${s.from})`
  const level = /^v2\.levels\.(\w+)$/.exec(s.path)
  if (s.kind === "info" && level) return `Level ${level[1]} is never chosen`
  return s.kind === "info" ? s.path : `${s.path}: ${s.from} → ${s.to}`
}

export const suggestionOptions = (c: CalibrationView): SuggestionOption[] =>
  c.suggestions.map((s) => ({
    title: suggestionTitle(s),
    description: `${s.why} · ${s.path}`,
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
