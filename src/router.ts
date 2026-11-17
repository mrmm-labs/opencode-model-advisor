import { qualify, resolveTier, type Config } from "./config.ts"
import type { Hint } from "./hint.ts"

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
