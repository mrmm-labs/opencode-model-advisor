/**
 * OpenTelemetry spans and metrics, sent as OTLP/HTTP JSON with no dependencies.
 *
 * Off unless an endpoint is configured. Spans of one session tree share a trace
 * id derived from the root session id, the same way opencode-claude-accounts
 * derives it, so both plugins' spans land in one trace. Spans and metrics carry
 * names, timings and counts: never prompt text.
 */
import { createHash, randomBytes } from "node:crypto"

import { connectorSpans, v2Attributes } from "./otel-v2.ts"
import type { DecisionV2 } from "./route-v2.ts"

export type OtelTarget = { endpoint: string; headers?: Record<string, string> }

export type Attr = string | number | boolean | undefined

export type Span = {
  name: string
  /** Session the span is about; recorded as `session.id`. */
  session?: string
  /** Session whose id seeds the trace id: the root of a subagent tree. */
  traceSession?: string
  start: number
  end: number
  attrs: Record<string, Attr>
  /** Routing v2 detail; adds its `route.*` and `connector.*` attributes, and one span per connector call. */
  v2?: DecisionV2
  error?: string
}

export const SERVICE = "opencode/model-advisor"
export const SCOPE = "opencode-model-advisor"
const MAX_QUEUE = 2000

export const traceIdFor = (session: string | undefined): string =>
  session
    ? createHash("sha256").update(session).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex")

export const newSpanId = (): string => randomBytes(8).toString("hex")

const value = (v: Exclude<Attr, undefined>) =>
  typeof v === "string"
    ? { stringValue: v }
    : typeof v === "boolean"
      ? { boolValue: v }
      : Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v }

const attributes = (attrs: Record<string, Attr>) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([key, v]) => ({ key, value: value(v as Exclude<Attr, undefined>) }))

const resource = {
  attributes: [{ key: "service.name", value: { stringValue: SERVICE } }],
}

/** Unix nanoseconds as a string from fractional milliseconds; a number cannot hold them exactly. */
const nanos = (ms: number): string => {
  let whole = Math.floor(ms)
  let frac = Math.round((ms - whole) * 1e6)
  if (frac >= 1e6) {
    whole += 1
    frac -= 1e6
  }
  return `${whole}${String(frac).padStart(6, "0")}`
}

export function encodeSpans(spans: readonly Span[]): object {
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: SCOPE },
            spans: spans.map((s) => ({
              traceId: traceIdFor(s.traceSession ?? s.session),
              spanId: newSpanId(),
              name: s.name,
              kind: 3,
              startTimeUnixNano: nanos(s.start),
              // A zero-length span reads as a negative duration in some viewers.
              endTimeUnixNano: nanos(Math.max(s.end, s.start + 0.001)),
              attributes: attributes({
                "session.id": s.session,
                ...s.attrs,
                ...(s.v2 && v2Attributes(s.v2)),
              }),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  }
}

type Labels = Record<string, Attr>
type CounterPoint = { attrs: Labels; value: number }
type HistogramPoint = {
  attrs: Labels
  count: number
  sum: number
  min: number
  max: number
  buckets: number[]
}

const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

const labelKey = (attrs: Labels) =>
  JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1)))

/** Accumulates counters and histograms between flushes: delta temporality. */
export class MetricBuffer {
  private counters = new Map<string, Map<string, CounterPoint>>()
  private histograms = new Map<string, Map<string, HistogramPoint>>()
  private since = Date.now()

  count(name: string, attrs: Labels, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, CounterPoint>()
    this.counters.set(name, series)
    const key = labelKey(attrs)
    const point = series.get(key) ?? { attrs, value: 0 }
    point.value += by
    series.set(key, point)
  }

  record(name: string, attrs: Labels, v: number): void {
    const series =
      this.histograms.get(name) ?? new Map<string, HistogramPoint>()
    this.histograms.set(name, series)
    const key = labelKey(attrs)
    const point = series.get(key) ?? {
      attrs,
      count: 0,
      sum: 0,
      min: v,
      max: v,
      buckets: Array.from({ length: BOUNDS.length + 1 }, () => 0),
    }
    point.count++
    point.sum += v
    point.min = Math.min(point.min, v)
    point.max = Math.max(point.max, v)
    const i = BOUNDS.findIndex((b) => v <= b)
    point.buckets[i < 0 ? BOUNDS.length : i]++
    series.set(key, point)
  }

  /** The OTLP/JSON body for everything since the last drain, or undefined when empty. */
  drain(now = Date.now()): object | undefined {
    const start = nanos(this.since)
    const end = nanos(now)
    const metrics: object[] = []
    for (const [name, series] of this.counters) {
      metrics.push({
        name,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: [...series.values()].map((p) => ({
            attributes: attributes(p.attrs),
            startTimeUnixNano: start,
            timeUnixNano: end,
            asInt: Number.isInteger(p.value) ? String(p.value) : undefined,
            asDouble: Number.isInteger(p.value) ? undefined : p.value,
          })),
        },
      })
    }
    for (const [name, series] of this.histograms) {
      metrics.push({
        name,
        unit: "ms",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [...series.values()].map((p) => ({
            attributes: attributes(p.attrs),
            startTimeUnixNano: start,
            timeUnixNano: end,
            count: String(p.count),
            sum: p.sum,
            min: p.min,
            max: p.max,
            bucketCounts: p.buckets.map(String),
            explicitBounds: BOUNDS,
          })),
        },
      })
    }
    this.counters.clear()
    this.histograms.clear()
    this.since = now
    if (!metrics.length) return undefined
    return {
      resourceMetrics: [
        { resource, scopeMetrics: [{ scope: { name: SCOPE }, metrics }] },
      ],
    }
  }
}

type Post = (url: string, init: RequestInit) => Promise<unknown>

/**
 * Buffers spans and metrics and posts them every few seconds. A failed post is
 * dropped, never retried, and nothing here throws into the host.
 */
export class Telemetry {
  readonly metrics = new MetricBuffer()
  private queue: Span[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private onExit = () => void this.flush()
  private target: () => OtelTarget | undefined
  private post: Post
  private everyMs: number

  constructor(
    target: () => OtelTarget | undefined,
    post: Post = fetch,
    everyMs = 2000,
  ) {
    this.target = target
    this.post = post
    this.everyMs = everyMs
    // A short run (`opencode run`) exits before the timer fires; send what is left.
    process.once?.("beforeExit", this.onExit)
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), this.everyMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  span(span: Span): void {
    if (!this.target()) return
    if (this.queue.length >= MAX_QUEUE) this.queue.shift()
    this.queue.push(span)
    if (span.v2) this.queue.push(...connectorSpans(span.v2, span))
    this.arm()
  }

  count(name: string, attrs: Labels, by = 1): void {
    if (!this.target()) return
    this.metrics.count(name, attrs, by)
    this.arm()
  }

  record(name: string, attrs: Labels, v: number): void {
    if (!this.target()) return
    this.metrics.record(name, attrs, v)
    this.arm()
  }

  async flush(): Promise<void> {
    this.timer = undefined
    const t = this.target()
    const spans = this.queue.splice(0)
    const metrics = this.metrics.drain()
    if (!t?.endpoint) return
    const base = t.endpoint.replace(/\/+$/, "")
    const send = async (path: string, body: object) => {
      try {
        await this.post(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...t.headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // A missing collector must never slow or break a session.
      }
    }
    await Promise.all([
      spans.length ? send("/v1/traces", encodeSpans(spans)) : undefined,
      metrics ? send("/v1/metrics", metrics) : undefined,
    ])
  }

  async dispose(): Promise<void> {
    process.off?.("beforeExit", this.onExit)
    await this.flush()
  }
}
