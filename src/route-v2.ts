/**
 * Routing v2 contract (docs/spec-routing-v2.md): facts with sources, a deterministic
 * difficulty score, a risk × difficulty policy, and levels that map to any provider's model.
 * Types here are shared by the router, connectors, calibration, telemetry and the TUI.
 */

export type Risk = "low" | "medium" | "high" | "critical"
export type Difficulty = "low" | "medium" | "high"
export type Level = string // "fast" | "standard" | "frontier" by default; config may add more
export type FactName =
  | "task"
  | "risk"
  | "files"
  | "modules"
  | "kind"
  | "migration"
  | "unknowns"
  | "retry"
  | "priorFailures"
  | "promptTokens"
  | "paths"
export type FactValue = string | number | boolean | string[]

/** Strongest first; the index is the precedence. */
export const SOURCE_ORDER = [
  "override",
  "connector",
  "caller",
  "derived",
  "default",
] as const
export type SourceKind = (typeof SOURCE_ORDER)[number]

/** One value for one fact from one source, e.g. connector "github" said risk=high. */
export type FactInput = {
  fact: FactName
  value: FactValue
  kind: SourceKind
  /** e.g. "hint", "github", "plugin:retry", "config". */
  source: string
  /** Free text kept for the decision record, e.g. "label tier:T1". */
  detail?: string
}

export type ResolvedFact = {
  value: FactValue
  kind: SourceKind
  source: string
  detail?: string
  /** Values from other sources that lost. */
  others: { value: FactValue; kind: SourceKind; source: string }[]
}

export type Facts = Partial<Record<FactName, ResolvedFact>>

export type Disagreement = {
  fact: FactName
  chosen: FactValue
  chosenSource: string
  values: { value: FactValue; source: string }[]
}

export type ScorePoint = {
  fact: FactName
  gte?: number
  eq?: FactValue
  in?: FactValue[]
  /** Add `add` for every `per` units of the fact (numeric facts). */
  per?: number
  add: number
  max?: number
}

export type Score = {
  total: number
  difficulty: Difficulty
  /** One entry per rubric line that added points, e.g. { fact: "files", add: 2 }. */
  breakdown: { fact: FactName; add: number }[]
}

export type ConnectorMap = {
  /** Regex on each label / tag name the connector returns. */
  label: string
  set?: Partial<Record<FactName, FactValue>>
  /** Operator override, e.g. { level: "frontier" }. */
  override?: { level?: Level }
}

export type ConnectorConfig = {
  id: string
  match?: { task?: string; agent?: string }
  /** argv; "{task}" is substituted. Output: JSON with labels[].name or a string[]. */
  command?: string[]
  http?: {
    url: string
    method?: "GET" | "POST"
    headers?: Record<string, string>
    /** JSON body template; "{task}" is substituted in string values. */
    body?: unknown
    /** Dot path to the label array in the response, e.g. "data.issue.labels.nodes". */
    labelsPath?: string
  }
  /** Dot path to the label array for command output (default "labels"). */
  labelsPath?: string
  timeoutMs: number
  ttlMinutes: number
  map: ConnectorMap[]
}

export type ConnectorResult = {
  id: string
  ok: boolean
  ms: number
  cached: boolean
  error?: string
  facts: FactInput[]
  override?: { level?: Level; detail: string }
}

export type RoutingV2Config = {
  /** false keeps v1 behaviour (tiers + rules) untouched. */
  enabled: boolean
  levels: Record<Level, { model: string }>
  /** Cheapest first; retry steps climb this. */
  levelOrder: Level[]
  difficulty: {
    points: ScorePoint[]
    cutoffs: { medium: number; high: number }
  }
  policy: {
    matrix: Record<Risk, Record<Difficulty, Level>>
    riskFloor: Partial<Record<Risk, Level>>
    retryStep: number
  }
  defaults: { risk: Risk }
  connectors: ConnectorConfig[]
  advisor: {
    level: Level
    impl: "auto" | "native" | "tool"
  }
  calibration: {
    /** First-pass rate under this in a bucket raises a suggestion. */
    minFirstPass: number
    /** Ignore buckets with fewer tasks. */
    minTasks: number
    /**
     * Agents whose re-dispatch of a task counts as a retry. Reviewers re-run every round, so
     * counting them would read every review round as a failure. Empty = every agent.
     */
    retryAgents: string[]
  }
}

export const defaultRoutingV2 = (): RoutingV2Config => ({
  enabled: false,
  levels: {
    fast: { model: "anthropic/claude-haiku-5-5" },
    standard: { model: "anthropic/claude-sonnet-5-5" },
    frontier: { model: "anthropic/claude-opus-5-5" },
  },
  levelOrder: ["fast", "standard", "frontier"],
  difficulty: {
    points: [
      { fact: "files", gte: 15, add: 2 },
      { fact: "modules", gte: 3, add: 2 },
      { fact: "migration", eq: true, add: 2 },
      { fact: "kind", in: ["new", "refactor", "migration"], add: 1 },
      { fact: "unknowns", per: 1, add: 1, max: 3 },
      { fact: "priorFailures", per: 1, add: 2 },
      { fact: "promptTokens", gte: 60000, add: 1 },
    ],
    cutoffs: { medium: 2, high: 4 },
  },
  policy: {
    matrix: {
      low: { low: "fast", medium: "standard", high: "frontier" },
      medium: { low: "standard", medium: "standard", high: "frontier" },
      high: { low: "frontier", medium: "frontier", high: "frontier" },
      critical: { low: "frontier", medium: "frontier", high: "frontier" },
    },
    riskFloor: { high: "frontier", critical: "frontier" },
    retryStep: 1,
  },
  defaults: { risk: "medium" },
  connectors: [],
  advisor: { level: "frontier", impl: "auto" },
  calibration: { minFirstPass: 0.7, minTasks: 5, retryAgents: ["builder"] },
})

/** What the v2 path adds to a decision; also written to decisions.jsonl as `v2`. */
export type DecisionV2 = {
  facts: Facts
  disagreements: Disagreement[]
  score: Score
  risk: Risk
  /** Level before floor/retry, after them, and why it moved. */
  matrixLevel: Level
  level: Level
  steps: string[]
  model: string
  connectors: {
    id: string
    ok: boolean
    ms: number
    cached: boolean
    error?: string
  }[]
}

export type ExplainInput = {
  agent: string
  prompt: string
  /** Facts from the hint line, the plugin and connectors, already collected. */
  inputs: FactInput[]
  override?: { level?: Level; detail: string }
}

// Implemented in src/facts.ts, src/score.ts, src/policy.ts (core builder).
export type ResolveFn = (inputs: FactInput[]) => {
  facts: Facts
  disagreements: Disagreement[]
}
export type ScoreFn = (facts: Facts, cfg: RoutingV2Config) => Score
/** Pure dry run used by the router and the TUI check command. */
export type ExplainFn = (
  input: ExplainInput,
  cfg: RoutingV2Config,
) => DecisionV2
