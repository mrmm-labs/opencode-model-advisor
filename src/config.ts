import { statSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Hint } from "./hint.ts"
import { parseJsonc } from "./jsonc.ts"
import { log } from "./logger.ts"
import {
  defaultRoutingV2,
  type ConnectorConfig,
  type ConnectorMap,
  type Difficulty,
  type FactName,
  type FactValue,
  type Risk,
  type RoutingV2Config,
  type ScorePoint,
} from "./route-v2.ts"

export type Mode = "shadow" | "enforce"

export type SidebarMode = "full" | "compact" | "off"

export type MatchInput = { agent: string; prompt: string; hint: Hint }

export type Rule = {
  id: string
  /** Short sentence for the sidebar's "Why" row, e.g. "touches auth / security". */
  label?: string
  tier: string
  test: (input: MatchInput) => boolean
  /** Matches on the agent alone; routing v2 treats such a rule as a floor. */
  agentOnly?: boolean
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
  /** The session sidebar block: how much it shows and where it sits. */
  tui: { sidebar: SidebarMode; position: "top" | "bottom" }
  /** What the decisions file records beyond the routing itself. */
  log: {
    /** A one-line, credential-filtered summary of each dispatched task. */
    summary: boolean
  }
  /** Routing v2 (docs/spec-routing-v2.md); off unless v2.enabled. */
  v2: RoutingV2Config
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
  tui: { sidebar: "compact", position: "bottom" },
  log: { summary: true },
  v2: defaultRoutingV2(),
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

const FACT_NAMES: readonly string[] = [
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
] satisfies FactName[]
const RISK_NAMES: Risk[] = ["low", "medium", "high", "critical"]
const DIFFICULTIES: Difficulty[] = ["low", "medium", "high"]

const isFactValue = (v: unknown): v is FactValue =>
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  strings(v) !== undefined

const validRegex = (v: unknown): v is string => {
  if (typeof v !== "string") return false
  try {
    compileRegex(v)
    return true
  } catch {
    return false
  }
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

function buildPoint(p: unknown): ScorePoint | string {
  if (!isObject(p)) return "not an object"
  if (typeof p.fact !== "string" || !FACT_NAMES.includes(p.fact))
    return `unknown fact ${JSON.stringify(p.fact)}`
  if (!finite(p.add)) return "`add` must be a number"
  const point: ScorePoint = { fact: p.fact as FactName, add: p.add }
  if (p.gte !== undefined) {
    if (!finite(p.gte)) return "`gte` must be a number"
    point.gte = p.gte
  }
  if (p.eq !== undefined) {
    if (!isFactValue(p.eq)) return "`eq` must be a string, number or boolean"
    point.eq = p.eq
  }
  if (p.in !== undefined) {
    if (!Array.isArray(p.in) || !p.in.every(isFactValue))
      return "`in` must be a list of values"
    point.in = p.in
  }
  if (p.per !== undefined) {
    if (!finite(p.per) || p.per <= 0) return "`per` must be a positive number"
    point.per = p.per
  }
  if (p.max !== undefined) {
    if (!finite(p.max)) return "`max` must be a number"
    point.max = p.max
  }
  if (
    point.gte === undefined &&
    point.eq === undefined &&
    !point.in &&
    point.per === undefined
  )
    return "needs one of gte, eq, in, per"
  return point
}

function buildMap(m: unknown): ConnectorMap | string {
  if (!isObject(m)) return "not an object"
  if (!validRegex(m.label)) return "`label` must be a valid regex"
  const out: ConnectorMap = { label: m.label }
  if (m.set !== undefined) {
    if (!isObject(m.set)) return "`set` must be an object"
    const set: Partial<Record<FactName, FactValue>> = {}
    for (const [k, v] of Object.entries(m.set)) {
      if (FACT_NAMES.includes(k) && isFactValue(v)) set[k as FactName] = v
    }
    out.set = set
  }
  if (m.override !== undefined) {
    if (!isObject(m.override) || typeof m.override.level !== "string")
      return "`override` must be { level: string }"
    out.override = { level: m.override.level }
  }
  if (!out.set && !out.override) return "needs `set` or `override`"
  return out
}

function buildConnector(c: unknown): ConnectorConfig | string {
  if (!isObject(c)) return "not an object"
  if (typeof c.id !== "string" || !c.id) return "`id` must be a string"
  const out: ConnectorConfig = {
    id: c.id,
    timeoutMs: 3000,
    ttlMinutes: 360,
    map: [],
  }
  const cmd = strings(c.command)
  if (cmd && cmd.length > 0) out.command = cmd
  else if (c.command !== undefined)
    return "`command` must be a non-empty list of strings"
  if (c.http !== undefined) {
    const h = c.http
    if (!isObject(h) || typeof h.url !== "string" || !h.url)
      return "`http.url` must be a string"
    out.http = { url: h.url }
    if (h.method === "GET" || h.method === "POST") out.http.method = h.method
    else if (h.method !== undefined) return "`http.method` must be GET or POST"
    if (isObject(h.headers))
      out.http.headers = Object.fromEntries(
        Object.entries(h.headers).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>
    if (h.body !== undefined) out.http.body = h.body
    if (typeof h.labelsPath === "string") out.http.labelsPath = h.labelsPath
  }
  if (!out.command && !out.http) return "needs `command` or `http`"
  if (typeof c.labelsPath === "string") out.labelsPath = c.labelsPath
  if (c.match !== undefined) {
    if (!isObject(c.match)) return "`match` must be an object"
    out.match = {}
    for (const key of ["task", "agent"] as const) {
      const v = c.match[key]
      if (v === undefined) continue
      if (!validRegex(v)) return `\`match.${key}\` must be a valid regex`
      out.match[key] = v
    }
  }
  for (const key of ["timeoutMs", "ttlMinutes"] as const) {
    const v = c[key]
    if (v === undefined) continue
    if (finite(v) && v > 0 && (key !== "timeoutMs" || v <= 10_000)) out[key] = v
    else
      return key === "timeoutMs"
        ? "`timeoutMs` must be between 1 and 10000"
        : "`ttlMinutes` must be a positive number"
  }
  if (c.map !== undefined) {
    if (!Array.isArray(c.map)) return "`map` must be a list"
    for (const [n, m] of c.map.entries()) {
      const built = buildMap(m)
      if (typeof built === "string") return `map #${n + 1}: ${built}`
      out.map.push(built)
    }
  }
  return out
}

/** Merges the `v2` section over the defaults in `v2`; a bad part keeps its default and warns. */
function buildV2(
  raw: Record<string, unknown>,
  v2: RoutingV2Config,
  warn: (m: string) => void,
): void {
  if (typeof raw.enabled === "boolean") v2.enabled = raw.enabled
  else if (raw.enabled !== undefined) warn("v2.enabled must be true or false")

  if (raw.levels !== undefined) {
    const l = raw.levels
    if (
      isObject(l) &&
      Object.keys(l).length > 0 &&
      Object.values(l).every(
        (e) => isObject(e) && typeof e.model === "string" && e.model,
      )
    ) {
      v2.levels = Object.fromEntries(
        Object.entries(l).map(([k, e]) => [
          k,
          { model: (e as { model: string }).model },
        ]),
      )
      v2.levelOrder = Object.keys(v2.levels)
    } else warn("v2.levels must map level names to { model }; using defaults")
  }
  const known = (name: unknown): name is string =>
    typeof name === "string" && Object.hasOwn(v2.levels, name)

  if (raw.levelOrder !== undefined) {
    const order = strings(raw.levelOrder)
    if (order && order.length > 0 && order.every(known)) v2.levelOrder = order
    else warn("v2.levelOrder must list level names that exist in v2.levels")
  }

  if (isObject(raw.defaults)) {
    const r = raw.defaults.risk
    if (typeof r === "string" && RISK_NAMES.includes(r as Risk))
      v2.defaults.risk = r as Risk
    else if (r !== undefined)
      warn("v2.defaults.risk must be low, medium, high or critical")
  } else if (raw.defaults !== undefined) warn("v2.defaults must be an object")

  if (isObject(raw.difficulty)) {
    const d = raw.difficulty
    if (d.points !== undefined) {
      if (Array.isArray(d.points)) {
        const points: ScorePoint[] = []
        d.points.forEach((p, n) => {
          const built = buildPoint(p)
          if (typeof built === "string")
            warn(`v2.difficulty.points #${n + 1}: ${built}; ignored`)
          else points.push(built)
        })
        v2.difficulty.points = points
      } else warn("v2.difficulty.points must be a list; using defaults")
    }
    if (isObject(d.cutoffs)) {
      const {
        medium = v2.difficulty.cutoffs.medium,
        high = v2.difficulty.cutoffs.high,
      } = d.cutoffs
      if (finite(medium) && finite(high) && medium <= high)
        v2.difficulty.cutoffs = { medium, high }
      else warn("v2.difficulty.cutoffs needs numbers with medium <= high")
    } else if (d.cutoffs !== undefined)
      warn("v2.difficulty.cutoffs must be an object")
  } else if (raw.difficulty !== undefined)
    warn("v2.difficulty must be an object")

  if (isObject(raw.policy)) {
    const p = raw.policy
    if (isObject(p.matrix)) {
      for (const risk of RISK_NAMES) {
        const row = p.matrix[risk]
        if (row === undefined) continue
        if (!isObject(row)) {
          warn(`v2.policy.matrix.${risk} must be an object`)
          continue
        }
        for (const diff of DIFFICULTIES) {
          const cell = row[diff]
          if (cell === undefined) continue
          if (known(cell)) v2.policy.matrix[risk][diff] = cell
          else
            warn(
              `v2.policy.matrix.${risk}.${diff}: ${JSON.stringify(cell)} is not a level; using default`,
            )
        }
      }
    } else if (p.matrix !== undefined)
      warn("v2.policy.matrix must be an object")
    if (isObject(p.riskFloor)) {
      const floor: Partial<Record<Risk, string>> = {}
      for (const [risk, level] of Object.entries(p.riskFloor)) {
        if (RISK_NAMES.includes(risk as Risk) && known(level))
          floor[risk as Risk] = level
        else warn(`v2.policy.riskFloor.${risk} names no risk or level; ignored`)
      }
      v2.policy.riskFloor = floor
    } else if (p.riskFloor !== undefined)
      warn("v2.policy.riskFloor must be an object")
    if (p.retryStep !== undefined) {
      if (
        typeof p.retryStep === "number" &&
        Number.isInteger(p.retryStep) &&
        p.retryStep >= 0
      )
        v2.policy.retryStep = p.retryStep
      else warn("v2.policy.retryStep must be a non-negative integer")
    }
  } else if (raw.policy !== undefined) warn("v2.policy must be an object")

  if (raw.connectors !== undefined) {
    if (Array.isArray(raw.connectors)) {
      const list: ConnectorConfig[] = []
      raw.connectors.forEach((c, n) => {
        const built = buildConnector(c)
        const id = isObject(c) && typeof c.id === "string" ? c.id : `#${n + 1}`
        if (typeof built === "string")
          warn(`v2.connectors ${id}: ${built}; ignored`)
        else list.push(built)
      })
      v2.connectors = list
    } else warn("v2.connectors must be a list")
  }

  if (isObject(raw.advisor)) {
    const a = raw.advisor
    if (known(a.level)) v2.advisor.level = a.level
    else if (a.level !== undefined)
      warn("v2.advisor.level must name a level in v2.levels")
    if (a.impl === "auto" || a.impl === "native" || a.impl === "tool")
      v2.advisor.impl = a.impl
    else if (a.impl !== undefined)
      warn('v2.advisor.impl must be "auto", "native" or "tool"')
  } else if (raw.advisor !== undefined) warn("v2.advisor must be an object")

  if (isObject(raw.calibration)) {
    const c = raw.calibration
    if (finite(c.minFirstPass) && c.minFirstPass >= 0 && c.minFirstPass <= 1)
      v2.calibration.minFirstPass = c.minFirstPass
    else if (c.minFirstPass !== undefined)
      warn("v2.calibration.minFirstPass must be between 0 and 1")
    if (
      typeof c.minTasks === "number" &&
      Number.isInteger(c.minTasks) &&
      c.minTasks > 0
    )
      v2.calibration.minTasks = c.minTasks
    else if (c.minTasks !== undefined)
      warn("v2.calibration.minTasks must be a positive integer")
    const agents = strings(c.retryAgents)
    if (agents) v2.calibration.retryAgents = agents
    else if (c.retryAgents !== undefined)
      warn("v2.calibration.retryAgents must be a list of agent names")
  } else if (raw.calibration !== undefined)
    warn("v2.calibration must be an object")

  // Defaults name fast/standard/frontier; custom levels that drop one of those cannot route.
  const dangling = new Set<string>()
  for (const row of Object.values(v2.policy.matrix))
    for (const level of Object.values(row))
      if (!known(level)) dangling.add(level)
  for (const level of Object.values(v2.policy.riskFloor))
    if (level && !known(level)) dangling.add(level)
  if (!known(v2.advisor.level)) dangling.add(v2.advisor.level)
  if (dangling.size > 0) {
    warn(
      `v2: no level named ${[...dangling].join(", ")}; set v2.policy and v2.advisor.level for your levels. Routing v2 stays off`,
    )
    v2.enabled = false
  }
}

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
        const agentOnly =
          isObject(r.when) && Object.keys(r.when).every((k) => k === "agent")
        const label = typeof r.label === "string" ? r.label.trim() : ""
        config.rules.push({
          id,
          tier,
          test,
          agentOnly,
          ...(label ? { label } : {}),
        })
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

  if (isObject(raw.tui)) {
    const pos = raw.tui.position
    if (pos === "top" || pos === "bottom") config.tui.position = pos
    else if (pos !== undefined) warn('tui.position must be "top" or "bottom"')
    const side = raw.tui.sidebar
    if (side === "full" || side === "compact" || side === "off")
      config.tui.sidebar = side
    else if (side !== undefined)
      warn('tui.sidebar must be "full", "compact" or "off"')
  } else if (raw.tui !== undefined) warn("tui must be an object")

  if (isObject(raw.log)) {
    const summary = raw.log.summary
    if (typeof summary === "boolean") config.log.summary = summary
    else if (summary !== undefined) warn("log.summary must be true or false")
  } else if (raw.log !== undefined) warn("log must be an object")

  if (isObject(raw.v2)) buildV2(raw.v2, config.v2, warn)
  else if (raw.v2 !== undefined)
    warn("v2 must be an object; routing v2 stays off")

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
