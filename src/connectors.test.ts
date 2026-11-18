import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createConnectors } from "./connectors.ts"
import type { ConnectorConfig } from "./route-v2.ts"

const base = (over: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id: "gh",
  command: ["gh", "issue", "view", "{task}", "--json", "labels"],
  timeoutMs: 200,
  ttlMinutes: 10,
  map: [
    { label: "^tier:T1$", set: { risk: "high" } },
    { label: "^route:frontier$", override: { level: "frontier" } },
  ],
  ...over,
})

const labelsJson = (...names: string[]) =>
  JSON.stringify({ labels: names.map((name) => ({ name })) })

const fakeRun = (stdout: string, calls: string[][] = [], code = 0) => ({
  async run(argv: string[]) {
    calls.push(argv)
    return { code, stdout }
  },
})

const clock = (t = 0) => {
  const c = { t, now: () => c.t }
  return c
}

describe("match and substitution", () => {
  it("only runs connectors whose task and agent regexes match", async () => {
    const calls: string[][] = []
    const c = createConnectors(
      [
        base({ id: "a", match: { task: "^\\d+$" } }),
        base({ id: "b", match: { task: "^[A-Z]+-\\d+$" } }),
        base({ id: "c", match: { agent: "^build$" } }),
        base({ id: "d" }),
      ],
      fakeRun(labelsJson(), calls),
    )
    const res = await c.lookup("42", "plan")
    assert.deepEqual(
      res.map((r) => r.id),
      ["a", "d"],
    )
    assert.deepEqual(
      (await c.lookup("42", "build")).map((r) => r.id),
      ["a", "c", "d"],
    )
  })

  it("substitutes {task} into argv elements without a shell", async () => {
    const calls: string[][] = []
    const c = createConnectors([base()], fakeRun(labelsJson(), calls))
    await c.lookup("1047", "x")
    assert.deepEqual(calls[0], [
      "gh",
      "issue",
      "view",
      "1047",
      "--json",
      "labels",
    ])
  })

  it("skips a bad task id with an error and never runs the command", async () => {
    const calls: string[][] = []
    const c = createConnectors([base()], fakeRun(labelsJson(), calls))
    for (const bad of ["", "1; rm -rf /", "a b", "$(x)", "x".repeat(65)]) {
      const [r] = await c.lookup(bad, "x")
      assert.equal(r!.ok, false)
      assert.equal(r!.error, "bad task id")
    }
    assert.equal(calls.length, 0)
  })

  it("accepts the documented id characters", async () => {
    const c = createConnectors([base()], fakeRun(labelsJson()))
    const [r] = await c.lookup("org/repo#12", "x")
    assert.equal(r!.ok, true)
  })
})

describe("output parsing", () => {
  it("reads labels as objects with name or as plain strings", async () => {
    const objs = createConnectors([base()], fakeRun(labelsJson("tier:T1")))
    assert.equal((await objs.lookup("1", "x"))[0]!.facts[0]!.value, "high")
    const strs = createConnectors(
      [base({ labelsPath: "data.tags" })],
      fakeRun(JSON.stringify({ data: { tags: ["tier:T1"] } })),
    )
    assert.equal((await strs.lookup("1", "x"))[0]!.facts[0]!.value, "high")
  })

  it("fails on non-JSON, a missing path and a non-zero exit", async () => {
    const [a] = await createConnectors([base()], fakeRun("not json")).lookup(
      "1",
      "x",
    )
    assert.equal(a!.ok, false)
    assert.match(a!.error!, /not JSON/)
    const [b] = await createConnectors([base()], fakeRun("{}")).lookup("1", "x")
    assert.match(b!.error!, /no label array at labels/)
    const [d] = await createConnectors([base()], fakeRun("", [], 1)).lookup(
      "1",
      "x",
    )
    assert.match(d!.error!, /exit 1/)
  })

  it("never throws when run rejects", async () => {
    const c = createConnectors([base()], {
      async run() {
        throw new Error("spawn gh ENOENT")
      },
    })
    const [r] = await c.lookup("1", "x")
    assert.equal(r!.ok, false)
    assert.match(r!.error!, /ENOENT/)
  })
})

describe("map", () => {
  it("emits connector facts with source and detail, case-insensitive", async () => {
    const c = createConnectors([base()], fakeRun(labelsJson("TIER:t1")))
    const [r] = await c.lookup("1", "x")
    assert.deepEqual(r!.facts, [
      {
        fact: "risk",
        value: "high",
        kind: "connector",
        source: "gh",
        detail: "label TIER:t1",
      },
    ])
    assert.equal(r!.override, undefined)
  })

  it("returns an override level with detail", async () => {
    const c = createConnectors([base()], fakeRun(labelsJson("route:frontier")))
    const [r] = await c.lookup("1", "x")
    assert.deepEqual(r!.override, {
      level: "frontier",
      detail: "gh label route:frontier",
    })
    assert.deepEqual(r!.facts, [])
  })

  it("applies several rules and several facts per rule", async () => {
    const c = createConnectors(
      [
        base({
          map: [
            { label: "^tier:T1$", set: { risk: "high" } },
            {
              label: "^kind:migration$",
              set: { kind: "migration", migration: true },
            },
            { label: "^route:", override: { level: "frontier" } },
            { label: "[unclosed", set: { risk: "low" } },
          ],
        }),
      ],
      fakeRun(labelsJson("tier:T1", "kind:migration", "route:frontier")),
    )
    const [r] = await c.lookup("1", "x")
    assert.deepEqual(
      r!.facts.map((f) => [f.fact, f.value]),
      [
        ["risk", "high"],
        ["kind", "migration"],
        ["migration", true],
      ],
    )
    assert.equal(r!.override?.level, "frontier")
  })
})

describe("timeout", () => {
  it("gives up after timeoutMs when the command hangs", async () => {
    const c = createConnectors([base({ timeoutMs: 20 })], {
      run: () => new Promise(() => {}),
    })
    const t0 = Date.now()
    const [r] = await c.lookup("1", "x")
    assert.ok(Date.now() - t0 < 500)
    assert.equal(r!.ok, false)
    assert.equal(r!.error, "timeout after 20ms")
  })

  it("aborts a hanging http call", async () => {
    let aborted = false
    const c = createConnectors(
      [
        {
          id: "h",
          http: { url: "https://x.test/{task}" },
          timeoutMs: 20,
          ttlMinutes: 1,
          map: [],
        },
      ],
      {
        fetch: ((_u: unknown, init?: RequestInit) =>
          new Promise(() => {
            init!.signal!.addEventListener("abort", () => (aborted = true))
          })) as typeof fetch,
      },
    )
    const [r] = await c.lookup("1", "x")
    assert.equal(r!.error, "timeout after 20ms")
    assert.equal(aborted, true)
  })
})

const linear = (
  over: Partial<ConnectorConfig["http"]> = {},
): ConnectorConfig => ({
  id: "linear",
  http: {
    url: "https://api.example.test/graphql",
    headers: { Authorization: "${KEY}" },
    body: {
      query: 'query { issue(id:"{task}") { labels { nodes { name } } } }',
    },
    labelsPath: "data.issue.labels.nodes",
    ...over,
  },
  timeoutMs: 200,
  ttlMinutes: 5,
  map: [{ label: "^tier:T2$", set: { risk: "medium" } }],
})
const reply = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("http", () => {
  it("posts the substituted body with env headers and reads labelsPath", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const c = createConnectors([linear()], {
      env: { KEY: "sekret" },
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response(
          JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "tier:T2" }] } } },
          }),
        )
      }) as unknown as typeof fetch,
    })
    const [r] = await c.lookup("ENG-12", "x")
    assert.equal(r!.ok, true)
    assert.equal(r!.facts[0]!.value, "medium")
    assert.equal(seen!.init.method, "POST")
    assert.equal(
      (seen!.init.headers as Record<string, string>).Authorization,
      "sekret",
    )
    assert.match(String(seen!.init.body), /issue\(id:\\"ENG-12\\"\)/)
  })

  it("url-encodes the task in the url", async () => {
    let url = ""
    const c = createConnectors([linear({ url: "https://x.test/{task}" })], {
      env: { KEY: "k" },
      fetch: (async (u: string) => {
        url = u
        return new Response("{}")
      }) as unknown as typeof fetch,
    })
    await c.lookup("a/b#1", "x")
    assert.equal(url, "https://x.test/a%2Fb%231")
  })

  it("reports a missing env var and http errors without leaking the header", async () => {
    const miss = createConnectors([linear()], { env: {}, fetch: reply({}) })
    assert.equal((await miss.lookup("1", "x"))[0]!.error, "missing env KEY")
    const bad = createConnectors([linear()], {
      env: { KEY: "sekret" },
      fetch: reply({}, 401),
    })
    assert.equal((await bad.lookup("1", "x"))[0]!.error, "http 401")
  })

  it("redacts header values from thrown errors", async () => {
    const c = createConnectors([linear()], {
      env: { KEY: "sekret-token" },
      fetch: (async () => {
        throw new Error(
          "failed with Authorization: sekret-token and sekret-token again",
        )
      }) as unknown as typeof fetch,
    })
    const [r] = await c.lookup("1", "x")
    assert.equal(r!.ok, false)
    assert.ok(!JSON.stringify(r).includes("sekret-token"))
    assert.match(r!.error!, /\[redacted\]/)
  })

  it("redacts the full header value when it wraps an env var", async () => {
    const c = createConnectors(
      [linear({ headers: { Authorization: "Bearer ${KEY}" } })],
      {
        env: { KEY: "abc" },
        fetch: (async () => {
          throw new Error("boom Bearer abc")
        }) as unknown as typeof fetch,
      },
    )
    const [r] = await c.lookup("1", "x")
    assert.equal(r!.error, "error: boom [redacted]")
  })
})

describe("cache", () => {
  it("serves a hit with cached:true and expires after the ttl", async () => {
    const calls: string[][] = []
    const t = clock()
    const c = createConnectors([base({ ttlMinutes: 1 })], {
      ...fakeRun(labelsJson(), calls),
      now: t.now,
    })
    assert.equal((await c.lookup("1", "x"))[0]!.cached, false)
    assert.equal((await c.lookup("1", "x"))[0]!.cached, true)
    assert.equal(calls.length, 1)
    t.t = 59_999
    assert.equal((await c.lookup("1", "x"))[0]!.cached, true)
    t.t = 60_001
    assert.equal((await c.lookup("1", "x"))[0]!.cached, false)
    assert.equal(calls.length, 2)
  })

  it("keys the cache per task", async () => {
    const calls: string[][] = []
    const c = createConnectors([base()], fakeRun(labelsJson(), calls))
    await c.lookup("1", "x")
    await c.lookup("2", "x")
    assert.equal(calls.length, 2)
  })

  it("caches errors for one minute only", async () => {
    const calls: string[][] = []
    const t = clock()
    const c = createConnectors([base({ ttlMinutes: 60 })], {
      ...fakeRun("nope", calls),
      now: t.now,
    })
    await c.lookup("1", "x")
    t.t = 30_000
    const hit = (await c.lookup("1", "x"))[0]!
    assert.equal(hit.cached, true)
    assert.equal(hit.ok, false)
    t.t = 60_001
    await c.lookup("1", "x")
    assert.equal(calls.length, 2)
  })

  it("shares one in-flight call between concurrent lookups", async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const c = createConnectors([base()], {
      async run() {
        n++
        await gate
        return { code: 0, stdout: labelsJson("tier:T1") }
      },
    })
    const all = Promise.all([
      c.lookup("1", "x"),
      c.lookup("1", "x"),
      c.lookup("1", "y"),
    ])
    release()
    const res = await all
    assert.equal(n, 1)
    assert.ok(res.every((r) => r[0]!.facts.length === 1))
  })

  it("keeps at most 50 entries per connector, dropping the oldest", async () => {
    const calls: string[][] = []
    const c = createConnectors([base()], fakeRun(labelsJson(), calls))
    for (let i = 0; i < 51; i++) await c.lookup(String(i), "x")
    assert.equal(calls.length, 51)
    await c.lookup("50", "x")
    assert.equal(calls.length, 51)
    await c.lookup("0", "x")
    assert.equal(calls.length, 52)
  })

  it("clear() empties the cache", async () => {
    const calls: string[][] = []
    const c = createConnectors([base()], fakeRun(labelsJson(), calls))
    await c.lookup("1", "x")
    c.clear()
    await c.lookup("1", "x")
    assert.equal(calls.length, 2)
  })
})

describe("test()", () => {
  it("bypasses and does not fill the cache, and returns labels", async () => {
    const calls: string[][] = []
    const c = createConnectors(
      [base()],
      fakeRun(labelsJson("tier:T1", "other"), calls),
    )
    await c.lookup("1", "x")
    const r = await c.test("gh", "1")
    assert.equal(calls.length, 2)
    assert.equal(r.cached, false)
    assert.deepEqual(r.labels, ["tier:T1", "other"])
    await c.test("gh", "2")
    assert.equal((await c.lookup("2", "x"))[0]!.cached, false)
  })

  it("ignores match filters but still checks the id", async () => {
    const c = createConnectors(
      [base({ match: { task: "^\\d+$" } })],
      fakeRun(labelsJson()),
    )
    assert.equal((await c.test("gh", "ENG-1")).ok, true)
    assert.equal((await c.test("gh", "bad id")).error, "bad task id")
    assert.equal((await c.test("nope", "1")).error, "unknown connector")
  })
})
