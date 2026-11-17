import { statSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Hint } from "./hint.ts"
import { parseJsonc } from "./jsonc.ts"
import { log } from "./logger.ts"

export type Mode = "shadow" | "enforce"

export type MatchInput = { agent: string; prompt: string; hint: Hint }

export type Rule = {
  id: string
  tier: string
  test: (input: MatchInput) => boolean
}

export type Config = {
  mode: Mode
  provider: string
  /** Tier name to model id; key order is the escalation ladder, cheapest first. */
  tiers: Record<string, string>
  ladder: string[]
  default: string
  orchestrators: string[]
  pins: Record<string, string>
  rules: Rule[]
  judge: { enabled: boolean; model: string; timeoutMs: number }
  advisor: {
    enabled: boolean
    /** Model id of the advisor; defaults to the top tier. */
    model: string
    maxUses: number
    /** Skip attaching above this many estimated context tokens (chars / 4). */
    maxContextTokens: number
    /** Alert when an executor turn has more steps than this and no advisor. */
    alertSteps: number
  }
  otel: { endpoint?: string; headers?: Record<string, string> }
}

export const DEFAULT_TIERS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
}

export const defaultConfig = (): Config => ({
  mode: "shadow",
  provider: "anthropic",
  tiers: { ...DEFAULT_TIERS },
  ladder: Object.keys(DEFAULT_TIERS),
  default: "sonnet",
  orchestrators: ["build", "plan", "coordinator"],
  pins: {},
  rules: [],
  judge: { enabled: false, model: DEFAULT_TIERS.haiku, timeoutMs: 8000 },
  advisor: {
    enabled: false,
    model: DEFAULT_TIERS.opus,
    maxUses: 2,
    maxContextTokens: 120_000,
    alertSteps: 15,
  },
  otel: {},
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string")
    ? (v as string[])
    : undefined

const COMPARE = /^(>=|<=|==|=|>|<)\s*(-?\d+(?:\.\d+)?)$/

/** Numeric comparison like ">=15", or a plain value / list of values. */
export function matchValue(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null || actual === "") return false
  if (Array.isArray(expected))
    return expected.some((e) => matchValue(actual, e))
  if (typeof expected === "number") return Number(actual) === expected
  if (typeof expected !== "string") return false
  const cmp = COMPARE.exec(expected.trim())
  if (cmp) {
    const a = Number(actual)
    const b = Number(cmp[2])
    if (Number.isNaN(a)) return false
    switch (cmp[1]) {
      case ">=":
        return a >= b
      case "<=":
        return a <= b
      case ">":
        return a > b
      case "<":
        return a < b
      default:
        return a === b
    }
  }
  return String(actual).toLowerCase() === expected.toLowerCase()
}

/** JavaScript has no inline flags, so a leading `(?i)` becomes the `i` flag. */
function compileRegex(source: string): RegExp {
  const insensitive = source.startsWith("(?i)")
  return new RegExp(
    insensitive ? source.slice(4) : source,
    insensitive ? "i" : "",
  )
}

const HINT_FIELDS = new Set(["task", "tier", "retry", "files"])

function compileWhen(when: unknown): ((input: MatchInput) => boolean) | string {
  if (!isObject(when) || Object.keys(when).length === 0)
    return "`when` must be a non-empty object"
  const tests: Array<(input: MatchInput) => boolean> = []
  for (const [key, expected] of Object.entries(when)) {
    if (key === "agent") {
      tests.push((i) => matchValue(i.agent, expected))
    } else if (key === "prompt") {
      if (typeof expected !== "string") return "`prompt` must be a regex string"
      let re: RegExp
      try {
        re = compileRegex(expected)
      } catch {
        return `invalid regex in \`prompt\`: ${expected}`
      }
      tests.push((i) => re.test(i.prompt))
    } else if (key === "prompt.length") {
      tests.push((i) => matchValue(i.prompt.length, expected))
    } else if (key.startsWith("hint.") && HINT_FIELDS.has(key.slice(5))) {
      const field = key.slice(5) as keyof Hint
      tests.push((i) => matchValue(i.hint[field], expected))
    } else {
      return `unknown condition \`${key}\``
    }
  }
  return (input) => tests.every((t) => t(input))
}

/** A tier name, or a model fragment such as "opus" or "claude-opus-5-5". */
export function resolveTier(value: string, config: Config): string | undefined {
  const v = value.trim().toLowerCase()
  if (!v) return undefined
  if (config.tiers[v]) return v
  return config.ladder.find((t) => config.tiers[t].toLowerCase().includes(v))
}

/** Model reference as OpenCode takes it: "provider/model". */
export const qualify = (model: string, provider: string): string =>
  model.includes("/") ? model : `${provider}/${model}`

export const bareModel = (model: string | undefined): string =>
  (model ?? "").split("/").pop() ?? ""

/** Validates a parsed config file; invalid parts fall back to defaults with a warning. */
export function buildConfig(raw: unknown): {
  config: Config
  warnings: string[]
} {
  const config = defaultConfig()
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  if (!isObject(raw)) {
    if (raw !== undefined) warn("config is not an object; using defaults")
    return { config, warnings }
  }

  if (raw.mode !== undefined) {
    if (raw.mode === "shadow" || raw.mode === "enforce") config.mode = raw.mode
    else
      warn(
        `mode must be "shadow" or "enforce", got ${JSON.stringify(raw.mode)}; using shadow`,
      )
  }
  if (typeof raw.provider === "string" && raw.provider)
    config.provider = raw.provider

  if (raw.tiers !== undefined) {
    if (
      isObject(raw.tiers) &&
      Object.keys(raw.tiers).length > 0 &&
      Object.values(raw.tiers).every((m) => typeof m === "string" && m)
    ) {
      config.tiers = Object.fromEntries(
        Object.entries(raw.tiers).map(([k, v]) => [
          k.toLowerCase(),
          v as string,
        ]),
      )
      config.ladder = Object.keys(config.tiers)
    } else warn("tiers must map tier names to model ids; using defaults")
  }
  if (
    typeof raw.default === "string" &&
    config.tiers[raw.default.toLowerCase()]
  ) {
    config.default = raw.default.toLowerCase()
  } else {
    if (raw.default !== undefined)
      warn(`default tier ${JSON.stringify(raw.default)} is not a tier`)
    if (!config.tiers[config.default])
      config.default = config.ladder[Math.floor(config.ladder.length / 2)]
  }

  if (raw.orchestrators !== undefined) {
    const list = strings(raw.orchestrators)
    if (list) config.orchestrators = list
    else warn("orchestrators must be a list of agent names")
  }

  if (raw.pins !== undefined) {
    if (isObject(raw.pins)) {
      for (const [key, value] of Object.entries(raw.pins)) {
        const tier =
          typeof value === "string" ? resolveTier(value, config) : undefined
        if (tier) config.pins[key] = tier
        else warn(`pin ${JSON.stringify(key)} names no tier; ignored`)
      }
    } else warn("pins must be an object")
  }

  if (raw.rules !== undefined) {
    if (Array.isArray(raw.rules)) {
      raw.rules.forEach((r, n) => {
        const id =
          isObject(r) && typeof r.id === "string" && r.id ? r.id : `#${n + 1}`
        if (!isObject(r)) return warn(`rule ${id}: not an object; ignored`)
        const tier =
          typeof r.tier === "string" ? resolveTier(r.tier, config) : undefined
        if (!tier)
          return warn(
            `rule ${id}: tier ${JSON.stringify(r.tier)} is not a tier; ignored`,
          )
        const test = compileWhen(r.when)
        if (typeof test === "string")
          return warn(`rule ${id}: ${test}; ignored`)
        config.rules.push({ id, tier, test })
      })
    } else warn("rules must be a list")
  }

  if (isObject(raw.judge)) {
    const j = raw.judge
    if (typeof j.enabled === "boolean") config.judge.enabled = j.enabled
    if (typeof j.model === "string" && j.model) config.judge.model = j.model
    else config.judge.model = config.tiers[config.ladder[0]]
    if (typeof j.timeoutMs === "number" && j.timeoutMs > 0)
      config.judge.timeoutMs = j.timeoutMs
    else if (j.timeoutMs !== undefined)
      warn("judge.timeoutMs must be a positive number")
  } else if (raw.judge !== undefined) warn("judge must be an object")

  config.advisor.model = config.tiers[config.ladder[config.ladder.length - 1]]
  if (isObject(raw.advisor)) {
    const a = raw.advisor
    if (typeof a.enabled === "boolean") config.advisor.enabled = a.enabled
    if (typeof a.model === "string" && a.model) config.advisor.model = a.model
    for (const key of ["maxUses", "maxContextTokens", "alertSteps"] as const) {
      const v = a[key]
      if (typeof v === "number" && Number.isInteger(v) && v > 0)
        config.advisor[key] = v
      else if (v !== undefined)
        warn(`advisor.${key} must be a positive integer; using default`)
    }
  } else if (raw.advisor !== undefined) warn("advisor must be an object")

  if (isObject(raw.otel)) {
    if (typeof raw.otel.endpoint === "string" && raw.otel.endpoint)
      config.otel.endpoint = raw.otel.endpoint
    if (isObject(raw.otel.headers)) {
      config.otel.headers = Object.fromEntries(
        Object.entries(raw.otel.headers).filter(
          ([, v]) => typeof v === "string",
        ),
      ) as Record<string, string>
    }
  }

  return { config, warnings }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_CONFIG)
    return env.OPENCODE_MODEL_ADVISOR_CONFIG
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "model-advisor.jsonc")
}

/** Reads the config file, re-reading it when its mtime or size changes (one stat per call). */
export class ConfigStore {
  private current = defaultConfig()
  private stamp = ""
  private path: () => string

  constructor(path: () => string = () => configPath()) {
    this.path = path
  }

  get(): Config {
    const path = this.path()
    let stamp = "missing"
    try {
      const s = statSync(path)
      stamp = `${path}:${s.mtimeMs}:${s.size}`
    } catch {
      stamp = `missing:${path}`
    }
    if (stamp === this.stamp) return this.current
    this.stamp = stamp
    if (stamp.startsWith("missing:")) {
      this.current = defaultConfig()
      return this.current
    }
    try {
      const { config, warnings } = buildConfig(
        parseJsonc(readFileSync(path, "utf8")),
      )
      for (const w of warnings) log("config_warning", { path, warning: w })
      log("config_loaded", {
        path,
        mode: config.mode,
        rules: config.rules.length,
        judge: config.judge.enabled,
      })
      this.current = config
    } catch (err) {
      log("config_error", {
        path,
        message: err instanceof Error ? err.message : String(err),
        keeping: "previous config",
      })
    }
    return this.current
  }
}
