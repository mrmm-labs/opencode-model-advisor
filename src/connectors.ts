import { execFile } from "node:child_process"

import type {
  ConnectorConfig,
  ConnectorResult,
  FactInput,
  FactName,
  FactValue,
} from "./route-v2.ts"

export type ConnectorDeps = {
  run?(
    argv: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string }>
  fetch?: typeof fetch
  now?(): number
  env?: NodeJS.ProcessEnv
}

export type Connectors = {
  lookup(task: string, agent: string): Promise<ConnectorResult[]>
  test(
    id: string,
    task: string,
  ): Promise<ConnectorResult & { labels: string[] }>
  clear(): void
}

const TASK_ID = /^[A-Za-z0-9._#/-]{1,64}$/
const ERROR_TTL_MS = 60_000
const MAX_ENTRIES = 50
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

type Outcome = { result: ConnectorResult; labels: string[] }
type Entry = { expires: number; outcome: Outcome }

const defaultRun: NonNullable<ConnectorDeps["run"]> = (argv, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    execFile(
      cmd!,
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1 << 20,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err && (err as { killed?: boolean }).killed)
          return reject(new Error("timeout"))
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0
        resolve({ code, stdout: String(stdout ?? "") })
      },
    )
  })

const subst = (s: string, task: string) => s.split("{task}").join(task)

const substDeep = (v: unknown, task: string): unknown => {
  if (typeof v === "string") return subst(v, task)
  if (Array.isArray(v)) return v.map((x) => substDeep(x, task))
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, substDeep(x, task)]),
    )
  return v
}

const regex = (src: string | undefined, flags = ""): RegExp | undefined => {
  if (src === undefined) return undefined
  try {
    return new RegExp(src, flags)
  } catch {
    return undefined
  }
}

const matches = (
  cfg: ConnectorConfig,
  task: string,
  agent: string,
): boolean => {
  for (const [src, value] of [
    [cfg.match?.task, task],
    [cfg.match?.agent, agent],
  ] as const) {
    if (src === undefined) continue
    const re = regex(src)
    if (!re || !re.test(value)) return false
  }
  return true
}

const dig = (data: unknown, path: string): unknown => {
  let cur = data
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, key))
      return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

const readLabels = (data: unknown, path: string): string[] | undefined => {
  const arr = dig(data, path)
  if (!Array.isArray(arr)) return undefined
  const out: string[] = []
  for (const item of arr) {
    if (typeof item === "string") out.push(item)
    else if (
      item &&
      typeof item === "object" &&
      typeof (item as { name?: unknown }).name === "string"
    )
      out.push((item as { name: string }).name)
  }
  return out
}

const applyMap = (cfg: ConnectorConfig, labels: string[]) => {
  const facts: FactInput[] = []
  let override: ConnectorResult["override"]
  for (const rule of cfg.map) {
    const re = regex(rule.label, "i")
    const label = re ? labels.find((l) => re.test(l)) : undefined
    if (label === undefined) continue
    for (const [fact, value] of Object.entries(rule.set ?? {})) {
      facts.push({
        fact: fact as FactName,
        value: value as FactValue,
        kind: "connector",
        source: cfg.id,
        detail: `label ${label}`,
      })
    }
    if (rule.override?.level && !override)
      override = {
        level: rule.override.level,
        detail: `${cfg.id} label ${label}`,
      }
  }
  return { facts, override }
}

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error("timeout"))
    }, ms)
  })
  try {
    return await Promise.race([p, limit])
  } finally {
    clearTimeout(timer)
    p.catch(() => {})
  }
}

export function createConnectors(
  cfgs: ConnectorConfig[],
  deps: ConnectorDeps = {},
): Connectors {
  const run = deps.run ?? defaultRun
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const caches = new Map<string, Map<string, Entry>>()
  const inflight = new Map<string, Promise<Outcome>>()

  const call = async (cfg: ConnectorConfig, task: string): Promise<Outcome> => {
    const start = now()
    const secrets: string[] = []
    const redact = (s: string) =>
      [...secrets]
        .sort((a, b) => b.length - a.length)
        .reduce((acc, v) => (v ? acc.split(v).join("[redacted]") : acc), s)
    const fail = (error: string): Outcome => ({
      result: {
        id: cfg.id,
        ok: false,
        ms: now() - start,
        cached: false,
        error: redact(error),
        facts: [],
      },
      labels: [],
    })
    if (!TASK_ID.test(task)) return fail("bad task id")

    try {
      let data: unknown
      let path = cfg.labelsPath ?? "labels"
      if (cfg.command?.length) {
        const argv = cfg.command.map((a) => subst(a, task))
        const res = await withTimeout(run(argv, cfg.timeoutMs), cfg.timeoutMs)
        if (res.code !== 0) return fail(`command exit ${res.code}`)
        try {
          data = JSON.parse(res.stdout)
        } catch {
          return fail("output is not JSON")
        }
      } else if (cfg.http) {
        const h = cfg.http
        path = h.labelsPath ?? cfg.labelsPath ?? "labels"
        const headers: Record<string, string> = {}
        for (const [name, raw] of Object.entries(h.headers ?? {})) {
          let missing: string | undefined
          headers[name] = raw.replace(ENV_REF, (_, key: string) => {
            const v = env[key]
            if (v === undefined) missing = key
            else secrets.push(v)
            return v ?? ""
          })
          if (missing) return fail(`missing env ${missing}`)
          secrets.push(headers[name]!)
        }
        const method = h.method ?? (h.body === undefined ? "GET" : "POST")
        const init: RequestInit = { method, headers }
        if (h.body !== undefined) {
          init.body = JSON.stringify(substDeep(h.body, task))
          if (
            !Object.keys(headers).some(
              (k) => k.toLowerCase() === "content-type",
            )
          )
            headers["Content-Type"] = "application/json"
        }
        const ctl = new AbortController()
        init.signal = ctl.signal
        const res = await withTimeout(
          doFetch(subst(h.url, encodeURIComponent(task)), init),
          cfg.timeoutMs,
          () => ctl.abort(),
        )
        if (!res.ok) return fail(`http ${res.status}`)
        try {
          data = JSON.parse(
            await withTimeout(res.text(), cfg.timeoutMs, () => ctl.abort()),
          )
        } catch (e) {
          if (e instanceof Error && e.message === "timeout") throw e
          return fail("response is not JSON")
        }
      } else {
        return fail("no command or http")
      }

      const labels = readLabels(data, path)
      if (!labels) return fail(`no label array at ${path}`)
      const { facts, override } = applyMap(cfg, labels)
      const result: ConnectorResult = {
        id: cfg.id,
        ok: true,
        ms: now() - start,
        cached: false,
        facts,
      }
      if (override) result.override = override
      return { result, labels }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === "timeout" || (e instanceof Error && e.name === "AbortError"))
        return fail(`timeout after ${cfg.timeoutMs}ms`)
      return fail(`error: ${msg.slice(0, 200)}`)
    }
  }

  const cached = async (
    cfg: ConnectorConfig,
    task: string,
  ): Promise<ConnectorResult> => {
    const t0 = now()
    const cache = caches.get(cfg.id) ?? new Map<string, Entry>()
    caches.set(cfg.id, cache)
    const hit = cache.get(task)
    if (hit && hit.expires > t0)
      return { ...hit.outcome.result, cached: true, ms: now() - t0 }
    if (hit) cache.delete(task)

    const key = `${cfg.id}\0${task}`
    let pending = inflight.get(key)
    if (!pending) {
      pending = call(cfg, task).then((outcome) => {
        const ttl = outcome.result.ok ? cfg.ttlMinutes * 60_000 : ERROR_TTL_MS
        if (ttl > 0) {
          cache.delete(task)
          cache.set(task, { expires: now() + ttl, outcome })
          while (cache.size > MAX_ENTRIES)
            cache.delete(cache.keys().next().value!)
        }
        return outcome
      })
      inflight.set(key, pending)
      pending.finally(() => inflight.delete(key)).catch(() => {})
    }
    return (await pending).result
  }

  return {
    async lookup(task, agent) {
      const out = await Promise.all(
        cfgs
          .filter((c) => matches(c, task, agent))
          .map((c) =>
            cached(c, task).catch(
              (): ConnectorResult => ({
                id: c.id,
                ok: false,
                ms: 0,
                cached: false,
                error: "error: internal",
                facts: [],
              }),
            ),
          ),
      )
      return out
    },
    async test(id, task) {
      const cfg = cfgs.find((c) => c.id === id)
      if (!cfg)
        return {
          id,
          ok: false,
          ms: 0,
          cached: false,
          error: "unknown connector",
          facts: [],
          labels: [],
        }
      const { result, labels } = await call(cfg, task)
      return { ...result, labels }
    },
    clear() {
      caches.clear()
      inflight.clear()
    },
  }
}
