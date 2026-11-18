import { qualify, resolveTier, type Config } from "./config.ts"
import { derivedFacts, explain } from "./explain.ts"
import { hintFacts, type Hint } from "./hint.ts"
import type { DecisionV2, FactInput, Level } from "./route-v2.ts"

export type JudgeOutcome =
  | { ok: true; tier: string; reason: string }
  | { ok: false; reason: string }

export type RouteInput = {
  sessionID: string
  agent: string
  /** The prompt with markers removed. */
  prompt: string
  hint: Hint
  override?: string
  /** Set on the second pass, after the judge ran. */
  judge?: JudgeOutcome
  /** Routing v2 only: what connectors found before the dispatch was routed. */
  v2?: {
    facts: FactInput[]
    override?: { level?: Level; detail: string }
    connectors: DecisionV2["connectors"]
  }
}

export type Decision = {
  tier: string
  /** "provider/model", as OpenCode takes it. */
  model: string
  /** pin | override | escalation | rule | judge | judge-failed | default */
  source: string
  rule?: string
  reason: string
  /** Set when an escalation decision climbed a tier or held it. */
  escalation?: "climb" | "stop"
  alert?: "second-failure"
  /** Routing v2 detail; set when the decision came from the v2 path. */
  v2?: DecisionV2
}

const MAX_TASKS = 1000

/** The tier last chosen for each task, in this process. Insertion order is recency. */
export class RouteState {
  private last = new Map<string, string>()

  get(task: string): string | undefined {
    return this.last.get(task)
  }

  set(task: string, tier: string): void {
    this.last.delete(task)
    this.last.set(task, tier)
    if (this.last.size > MAX_TASKS) {
      const oldest = this.last.keys().next().value
      if (oldest !== undefined) this.last.delete(oldest)
    }
  }
}

/** Why a dispatch is never routed, or undefined when it is. */
export function skipReason(
  agent: string | undefined,
  config: Config,
): string | undefined {
  if (!agent) return "no agent"
  if (config.orchestrators.some((o) => o.toLowerCase() === agent.toLowerCase()))
    return "orchestrator"
  return undefined
}

const decide = (
  config: Config,
  tier: string,
  source: string,
  reason: string,
  extra: Partial<Decision> = {},
): Decision => ({
  tier,
  model: qualify(config.tiers[tier], config.provider),
  source,
  reason,
  ...extra,
})

const above = (config: Config, tier: string): string =>
  config.ladder[
    Math.min(config.ladder.indexOf(tier) + 1, config.ladder.length - 1)
  ]

/** The level an override marker names: a level name, else a fragment of a level's model. */
function levelFor(value: string, config: Config): Level | undefined {
  const v = value.trim().toLowerCase()
  if (!v) return undefined
  const { levels, levelOrder } = config.v2
  return (
    levelOrder.find((l) => l.toLowerCase() === v) ??
    levelOrder.find((l) => levels[l].model.toLowerCase().includes(v))
  )
}

/** Same position on the level ladder as the tier has on the v1 ladder. */
function floorLevel(tier: string, config: Config): Level {
  const { levelOrder } = config.v2
  return levelOrder[
    Math.min(config.ladder.indexOf(tier), levelOrder.length - 1)
  ]
}

function routeV2(
  input: RouteInput,
  config: Config,
  state: RouteState,
  override?: { level: Level; detail: string },
): Decision {
  const { hint } = input
  const dispatchedBefore = !!hint.task && state.get(hint.task) !== undefined
  const operator = override ?? input.v2?.override
  const v2 = explain(
    {
      agent: input.agent,
      prompt: input.prompt,
      inputs: [
        ...hintFacts(hint),
        ...derivedFacts(input.prompt, hint, dispatchedBefore),
        ...(input.v2?.facts ?? []),
      ],
      override: operator,
    },
    config.v2,
  )
  v2.connectors = input.v2?.connectors ?? []

  let rule: string | undefined
  if (!operator?.level) {
    const floor = config.rules.find((r) => r.agentOnly && r.test(input))
    if (floor) {
      const level = floorLevel(floor.tier, config)
      const { levelOrder } = config.v2
      if (levelOrder.indexOf(level) > levelOrder.indexOf(v2.level)) {
        v2.level = level
        v2.model = config.v2.levels[level].model
        v2.steps.push(`agent rule ${floor.id} floor → ${level}`)
        rule = floor.id
      }
    }
  }

  const retry = hint.retry ?? 0
  const score = v2.score.breakdown.map(
    (b) => `${b.fact}${b.add > 0 ? "+" : ""}${b.add}`,
  )
  return {
    tier: v2.level,
    model: qualify(v2.model, config.provider),
    source:
      operator?.level && Object.hasOwn(config.v2.levels, operator.level)
        ? "override"
        : "v2",
    ...(rule ? { rule } : {}),
    reason: `risk ${v2.risk}, score ${v2.score.total}${score.length ? ` (${score.join(" ")})` : ""} ${v2.score.difficulty}; ${v2.steps.join("; ")}`,
    ...(retry >= 1
      ? {
          escalation: retry >= 2 ? ("stop" as const) : ("climb" as const),
          ...(retry >= 2 ? { alert: "second-failure" as const } : {}),
        }
      : {}),
    v2,
  }
}

/**
 * First match wins: pin, override marker, escalation, rules, judge, default.
 * Returns "judge" when only the judge can decide and has not run yet; call again
 * with `input.judge` set.
 */
export function route(
  input: RouteInput,
  config: Config,
  state: RouteState,
): Decision | "judge" {
  const pin =
    config.pins[`session:${input.sessionID}`] ?? config.pins[input.agent]
  if (pin && config.tiers[pin])
    return decide(config, pin, "pin", "operator pin")

  if (config.v2.enabled && input.override) {
    const level = levelFor(input.override, config)
    if (level)
      return routeV2(input, config, state, {
        level,
        detail: `prompt marker ${input.override}`,
      })
  }

  if (input.override) {
    const tier = resolveTier(input.override, config)
    if (tier)
      return decide(
        config,
        tier,
        "override",
        `prompt override ${input.override}`,
      )
  }

  if (config.v2.enabled) return routeV2(input, config, state)

  const matched = config.rules.find((r) => r.test(input))

  const retry = input.hint.retry ?? 0
  if (retry >= 1) {
    const last = input.hint.task ? state.get(input.hint.task) : undefined
    const base = last ?? matched?.tier ?? config.default
    if (retry >= 2 && last) {
      return decide(
        config,
        last,
        "escalation",
        `retry ${retry}: held at ${last}, stop climbing`,
        {
          escalation: "stop",
          alert: "second-failure",
        },
      )
    }
    const tier = above(config, base)
    return decide(
      config,
      tier,
      "escalation",
      `retry ${retry}: ${tier === base ? `already at ${base}` : `${base} to ${tier}`}`,
      retry >= 2
        ? { escalation: "stop", alert: "second-failure" }
        : { escalation: "climb" },
    )
  }

  if (matched)
    return decide(config, matched.tier, "rule", `rule ${matched.id}`, {
      rule: matched.id,
    })

  if (config.judge.enabled) {
    if (!input.judge) return "judge"
    if (input.judge.ok)
      return decide(config, input.judge.tier, "judge", input.judge.reason)
    return decide(config, config.default, "judge-failed", input.judge.reason)
  }

  return decide(config, config.default, "default", "no rule matched")
}
