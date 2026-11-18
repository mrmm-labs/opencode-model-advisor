/**
 * Routing v2 telemetry: span attributes for a decision, one span per connector
 * call, and the calibration report as spans (docs/telemetry.md). Names, numbers
 * and enum-like values only: never prompt text.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { Telemetry, type Attr, type OtelTarget, type Span } from "./otel.ts"
import type { DecisionV2, FactName, FactValue } from "./route-v2.ts"

/** Every fact the contract defines; bounds the attributes one decision can carry. */
export const FACT_NAMES = [
  "task",
  "risk",
  "files",
  "modules",
  "kind",
  "migration",
  "unknowns",
  "retry",
  "priorFailures",
  "promptTokens",
  "paths",
] as const satisfies readonly FactName[]

const MAX_CONNECTORS = 8
const MAX_TEXT = 200

const text = (s: string) => s.slice(0, MAX_TEXT)
const scalar = (v: FactValue): Exclude<Attr, undefined> =>
  Array.isArray(v) ? text(v.join(",")) : typeof v === "string" ? text(v) : v

export function v2Attributes(d: DecisionV2): Record<string, Attr> {
  const attrs: Record<string, Attr> = {
    "route.level": d.level,
    "route.matrix_level": d.matrixLevel,
    "route.risk": d.risk,
    "route.difficulty": d.score.difficulty,
    "route.score": d.score.total,
    "route.score.breakdown": text(
      d.score.breakdown.map((b) => `${b.fact}+${b.add}`).join(" "),
    ),
    "route.steps": text(d.steps.join("; ")),
    "route.disagreements": d.disagreements.length,
    "route.disagreement.facts": text(
      [...new Set(d.disagreements.map((x) => x.fact))].join(","),
    ),
  }
  for (const name of FACT_NAMES) {
    const fact = d.facts[name]
    if (!fact) continue
    attrs[`route.fact.${name}`] = scalar(fact.value)
    attrs[`route.fact.${name}.source`] = text(`${fact.kind}:${fact.source}`)
  }
  for (const c of d.connectors.slice(0, MAX_CONNECTORS)) {
    attrs[`connector.${c.id}.ms`] = Math.round(c.ms)
    attrs[`connector.${c.id}.ok`] = c.ok
    attrs[`connector.${c.id}.cached`] = c.cached
    attrs[`connector.${c.id}.error`] = c.error ? text(c.error) : undefined
  }
  return attrs
}

/** One span per connector call, so the collector can count and time them by connector id. */
export function connectorSpans(
  d: DecisionV2,
  base: Pick<Span, "session" | "traceSession" | "start" | "end">,
): Span[] {
  const { session, traceSession, start, end } = base
  return d.connectors.slice(0, MAX_CONNECTORS).map((c) => ({
    session,
    traceSession,
    start,
    end,
    name: `connector ${c.id}`,
    attrs: {
      "connector.id": c.id,
      "connector.ms": Math.round(c.ms),
      "connector.ok": c.ok,
      "connector.cached": c.cached,
      "connector.error": c.error ? text(c.error) : undefined,
    },
    error: c.ok ? undefined : text(c.error ?? "failed"),
  }))
}

/** What the calibrate command writes (spec section 7). */
export type Calibration = {
  v: 1
  t: string | number
  window_days?: number
  tasks?: number
  buckets: {
    risk: string
    difficulty: string
    level: string
    tasks: number
    firstPass: number
    avgRetries: number
    costPerTask: number
  }[]
  backtest?: { monotonic?: boolean }
  suggestions?: unknown[]
}

export const BUCKET_SPAN = "model-advisor calibration bucket"
export const SUMMARY_SPAN = "model-advisor calibration summary"

export function calibrationSpans(cal: Calibration, now: number): Span[] {
  if (cal?.v !== 1 || !Array.isArray(cal.buckets)) return []
  const traceSession = `calibration:${cal.t}`
  const buckets = cal.buckets
    .filter((b) => typeof b?.risk === "string" && Number.isFinite(b.tasks))
    .map(
      (b): Span => ({
        traceSession,
        start: now,
        end: now,
        name: BUCKET_SPAN,
        attrs: {
          risk: b.risk,
          difficulty: b.difficulty,
          level: b.level,
          tasks: b.tasks,
          first_pass: b.firstPass,
          avg_retries: b.avgRetries,
          cost_per_task: b.costPerTask,
        },
      }),
    )
  return [
    ...buckets,
    {
      traceSession,
      start: now,
      end: now,
      name: SUMMARY_SPAN,
      attrs: {
        monotonic: cal.backtest?.monotonic,
        suggestions: Array.isArray(cal.suggestions)
          ? cal.suggestions.length
          : 0,
        tasks: cal.tasks,
        window_days: cal.window_days,
      },
    },
  ]
}

export function calibrationPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_CALIBRATION)
    return env.OPENCODE_MODEL_ADVISOR_CALIBRATION
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "model-advisor", "calibration.json")
}

/** Sends the calibration report as spans. No file, no endpoint or a bad file: nothing happens. */
export async function exportCalibration(
  target: OtelTarget | undefined,
  opts: {
    path?: string
    now?: number
    post?: ConstructorParameters<typeof Telemetry>[1]
  } = {},
): Promise<number> {
  if (!target?.endpoint) return 0
  let spans: Span[]
  try {
    const cal = JSON.parse(
      readFileSync(opts.path ?? calibrationPath(), "utf8"),
    ) as Calibration
    spans = calibrationSpans(cal, opts.now ?? Date.now())
  } catch {
    return 0
  }
  const telemetry = new Telemetry(() => target, opts.post)
  for (const s of spans) telemetry.span(s)
  await telemetry.dispose()
  return spans.length
}
