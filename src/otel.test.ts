import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { encodeSpans, MetricBuffer, Telemetry, traceIdFor } from "./otel.ts"

describe("traceIdFor", () => {
  it("matches the sha256-prefix algorithm other plugins use for a root session", () => {
    assert.equal(
      traceIdFor("ses_abc"),
      createHash("sha256").update("ses_abc").digest("hex").slice(0, 32),
    )
    assert.equal(traceIdFor("ses_abc"), traceIdFor("ses_abc"))
    assert.notEqual(traceIdFor(undefined), traceIdFor(undefined))
  })
})

describe("encodeSpans", () => {
  it("puts spans in the root session's trace with typed attributes", () => {
    const body = encodeSpans([
      {
        name: "route builder",
        session: "ses_child",
        traceSession: "ses_root",
        start: 1000,
        end: 1500,
        attrs: {
          "route.retry": 1,
          ok: true,
          ratio: 0.5,
          skip: undefined,
          empty: "",
        },
      },
      {
        name: "failed",
        session: "ses_root",
        start: 2000,
        end: 1999,
        attrs: {},
        error: "boom",
      },
    ]) as any
    const resource = body.resourceSpans[0].resource.attributes[0]
    assert.deepEqual(resource, {
      key: "service.name",
      value: { stringValue: "opencode/model-advisor" },
    })
    const [a, b] = body.resourceSpans[0].scopeSpans[0].spans
    assert.equal(a.traceId, traceIdFor("ses_root"))
    assert.equal(b.traceId, traceIdFor("ses_root"))
    assert.deepEqual(a.attributes, [
      { key: "session.id", value: { stringValue: "ses_child" } },
      { key: "route.retry", value: { intValue: "1" } },
      { key: "ok", value: { boolValue: true } },
      { key: "ratio", value: { doubleValue: 0.5 } },
    ])
    assert.equal(a.startTimeUnixNano, "1000000000")
    assert.equal(a.endTimeUnixNano, "1500000000")
    assert.equal(a.status.code, 1)
    assert.deepEqual(b.status, { code: 2, message: "boom" })
    assert.ok(
      BigInt(b.endTimeUnixNano) > BigInt(b.startTimeUnixNano),
      "end is after start, even for a zero-length span",
    )
    assert.match(a.spanId, /^[0-9a-f]{16}$/)
  })
})

describe("timestamps", () => {
  it("keeps sub-millisecond precision as an exact nanosecond string", () => {
    const body = encodeSpans([
      {
        name: "fast",
        start: 1700000000000.25,
        end: 1700000000000.75,
        attrs: {},
      },
    ]) as any
    const span = body.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.startTimeUnixNano, "1700000000000250000")
    assert.equal(span.endTimeUnixNano, "1700000000000750000")
  })
})

describe("MetricBuffer", () => {
  it("sums counters per label set as delta and resets after a drain", () => {
    const m = new MetricBuffer()
    m.count("c", { a: "x", changed: true })
    m.count("c", { changed: true, a: "x" })
    m.count("c", { a: "y", changed: false }, 2)
    m.count("money", { a: "x" }, 0.25)
    const body = m.drain(5000) as any
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
    const c = metrics.find((x: any) => x.name === "c").sum
    assert.equal(c.aggregationTemporality, 1)
    assert.equal(c.isMonotonic, true)
    assert.equal(c.dataPoints.length, 2)
    assert.equal(c.dataPoints[0].asInt, "2")
    assert.deepEqual(c.dataPoints[0].attributes, [
      { key: "a", value: { stringValue: "x" } },
      { key: "changed", value: { boolValue: true } },
    ])
    assert.equal(c.dataPoints[1].asInt, "2")
    assert.equal(
      metrics.find((x: any) => x.name === "money").sum.dataPoints[0].asDouble,
      0.25,
    )
    assert.equal(m.drain(6000), undefined)
  })

  it("buckets histograms and links consecutive windows", () => {
    const m = new MetricBuffer()
    m.record("d", { agent: "a" }, 3)
    m.record("d", { agent: "a" }, 60)
    m.record("d", { agent: "a" }, 99999)
    const first = (m.drain(10_000) as any).resourceMetrics[0].scopeMetrics[0]
      .metrics[0]
    const p = first.histogram.dataPoints[0]
    assert.equal(first.histogram.aggregationTemporality, 1)
    assert.equal(p.count, "3")
    assert.equal(p.sum, 3 + 60 + 99999)
    assert.equal(p.min, 3)
    assert.equal(p.max, 99999)
    assert.equal(p.bucketCounts.length, p.explicitBounds.length + 1)
    assert.deepEqual(
      p.bucketCounts.map(Number).reduce((a: number, b: number) => a + b),
      3,
    )
    assert.equal(p.bucketCounts[1], "1", "3ms is in the 5ms bucket")
    assert.equal(p.bucketCounts.at(-1), "1", "99999ms overflows")
    m.record("d", { agent: "a" }, 1)
    const second = (m.drain(20_000) as any).resourceMetrics[0].scopeMetrics[0]
      .metrics[0]
    assert.equal(
      second.histogram.dataPoints[0].startTimeUnixNano,
      "10000000000",
    )
  })
})

const sink = () => {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  const post = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init.body as string),
      headers: init.headers,
    })
  }
  return { calls, post }
}

describe("Telemetry", () => {
  it("posts spans and metrics to their own paths, with headers", async () => {
    const { calls, post } = sink()
    const t = new Telemetry(
      () => ({ endpoint: "http://c:4318/", headers: { authorization: "x" } }),
      post,
      60_000,
    )
    t.span({ name: "s", session: "a", start: 1, end: 2, attrs: {} })
    t.count("c", {})
    t.record("h", {}, 5)
    await t.dispose()
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "http://c:4318/v1/metrics",
      "http://c:4318/v1/traces",
    ])
    assert.equal(calls[0].headers.authorization, "x")
    assert.equal(
      calls.find((c) => c.url.endsWith("metrics"))?.body.resourceMetrics[0]
        .scopeMetrics[0].metrics.length,
      2,
    )
  })

  it("does nothing, and keeps nothing, when no endpoint is set", async () => {
    const { calls, post } = sink()
    let on = false
    const t = new Telemetry(
      () => (on ? { endpoint: "http://c" } : undefined),
      post,
      60_000,
    )
    t.span({ name: "s", start: 1, end: 2, attrs: {} })
    t.count("c", {})
    on = true
    await t.dispose()
    assert.equal(calls.length, 0)
  })

  it("never throws when the collector is down", async () => {
    const t = new Telemetry(
      () => ({ endpoint: "http://c" }),
      async () => {
        throw new Error("ECONNREFUSED")
      },
      60_000,
    )
    t.count("c", {})
    await assert.doesNotReject(() => t.dispose())
  })

  it("drops the oldest span past the queue cap", async () => {
    const { calls, post } = sink()
    const t = new Telemetry(() => ({ endpoint: "http://c" }), post, 60_000)
    for (let i = 0; i < 2005; i++)
      t.span({ name: `s${i}`, start: 1, end: 2, attrs: {} })
    await t.dispose()
    const spans = calls[0].body.resourceSpans[0].scopeSpans[0].spans
    assert.equal(spans.length, 2000)
    assert.equal(spans[0].name, "s5")
  })
})
