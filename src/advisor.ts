import { bareModel, type Config } from "./config.ts"
import { parseMarkers } from "./hint.ts"
import { runJudge, type JudgeFn } from "./judge.ts"
import { log } from "./logger.ts"
import type { Telemetry } from "./otel.ts"
import { listCostUsd, savingUsd, type Usage } from "./pricing.ts"
import { route, RouteState, skipReason, type RouteInput } from "./router.ts"

export type SessionInfo = { parentID?: string; model?: string }

export type Deps = {
  config: () => Config
  telemetry: Telemetry
  session: (id: string) => Promise<SessionInfo | undefined>
  /** Absent when the host offers no one-shot model call; the judge step is then skipped. */
  judge?: JudgeFn
  now?: () => number
}

export type Dispatch = {
  /** The dispatching session. */
  sessionID: string
  agent?: string
  prompt: string
  /** The model the caller asked for, as "provider/model" or a bare id. */
  model?: string
  /** True when continuing an existing child session; those are never re-routed. */
  continuing?: boolean
}

/** What the host must change on the dispatch. Empty in shadow mode. */
export type Applied = { model?: string; prompt?: string }

export type HostEvent = { type: string; data?: Record<string, any> }

type Pending = { agent: string; would: string; at: number }
type Child = { agent: string; would: string; model: string }

const PENDING_TTL_MS = 10 * 60_000
const MAX_CHILDREN = 2000

export function createAdvisor(deps: Deps) {
  // Fractional milliseconds: most decisions take well under one.
  const now = deps.now ?? (() => performance.timeOrigin + performance.now())
  const state = new RouteState()
  const parents = new Map<string, string | null>()
  const pending = new Map<string, Pending[]>()
  const children = new Map<string, Child>()

  /** The top of the session's parent chain, cached; the trace id derives from it. */
  async function rootOf(id: string, first?: SessionInfo): Promise<string> {
    let cur = id
    for (let hop = 0; hop < 10; hop++) {
      let parent = parents.get(cur)
      if (parent === undefined) {
        const info =
          cur === id && first
            ? first
            : await deps.session(cur).catch(() => undefined)
        parent = info?.parentID ?? null
        parents.set(cur, parent)
      }
      if (!parent) break
      cur = parent
    }
    return cur
  }

  async function run(d: Dispatch): Promise<Applied | undefined> {
    const config = deps.config()
    if (d.continuing) return undefined
    if (skipReason(d.agent, config)) return undefined
    const agent = d.agent as string
    const start = now()

    const markers = parseMarkers(d.prompt)
    const info = await deps.session(d.sessionID).catch(() => undefined)
    const callerModel = bareModel(d.model) || bareModel(info?.model)
    const effective: Config = deps.judge
      ? config
      : { ...config, judge: { ...config.judge, enabled: false } }
    const input: RouteInput = {
      sessionID: d.sessionID,
      agent,
      prompt: markers.stripped,
      hint: markers.hint,
      override: markers.override,
    }

    let result = route(input, effective, state)
    let judgeMs: number | undefined
    if (result === "judge" && deps.judge) {
      const judged = await runJudge(
        deps.judge,
        config,
        agent,
        markers.stripped,
        now,
      )
      deps.telemetry.count("model_advisor.judge.calls", {
        outcome: judged.ok ? "ok" : judged.outcome,
      })
      judgeMs = judged.ms
      input.judge = judged.ok
        ? { ok: true, tier: judged.tier, reason: judged.reason }
        : { ok: false, reason: judged.reason }
      result = route(input, effective, state)
    }
    if (result === "judge") return undefined
    const decision = result

    if (markers.hint.task) state.set(markers.hint.task, decision.tier)

    const enforce = config.mode === "enforce"
    const would = bareModel(decision.model)
    const changed = would !== callerModel
    const applied = enforce ? would : callerModel
    const end = now()

    if (decision.escalation) {
      deps.telemetry.count("model_advisor.escalations", {
        agent,
        step: decision.escalation,
      })
    }
    if (decision.alert) {
      log("alert", {
        alert: decision.alert,
        agent,
        task: markers.hint.task,
        tier: decision.tier,
      })
    }

    deps.telemetry.count("model_advisor.decisions", {
      agent,
      source: decision.source,
      mode: config.mode,
      model: applied,
      would,
      changed,
    })
    deps.telemetry.record(
      "model_advisor.decision.duration",
      { agent, source: decision.source, mode: config.mode },
      end - start,
    )
    deps.telemetry.span({
      name: `route ${agent}`,
      session: d.sessionID,
      traceSession: await rootOf(d.sessionID, info),
      start,
      end,
      attrs: {
        "opencode.agent": agent,
        "route.mode": config.mode,
        "route.model": applied,
        "route.would": would,
        "route.tier": decision.tier,
        "route.source": decision.source,
        "route.rule": decision.rule,
        "route.reason": decision.reason.slice(0, 200),
        "route.caller_model": callerModel,
        "route.task": markers.hint.task,
        "route.hint_tier": markers.hint.tier,
        "route.retry": markers.hint.retry,
        "route.judge_ms":
          judgeMs === undefined ? undefined : Math.round(judgeMs),
        "route.alert": decision.alert,
      },
    })

    if (!enforce) {
      const key = `${d.sessionID}|${agent}`
      const queue = pending.get(key) ?? []
      queue.push({ agent, would, at: end })
      pending.set(key, queue.slice(-100))
      return undefined
    }
    const applying: Applied = {}
    if (changed || !callerModel) applying.model = decision.model
    if (markers.found) applying.prompt = markers.stripped
    return applying.model || applying.prompt ? applying : undefined
  }

  /** Ties a new child session to the shadow decision that preceded it. */
  function claim(
    parentID: string,
    agent: string | undefined,
  ): Pending | undefined {
    const keys = agent
      ? [`${parentID}|${agent}`]
      : [...pending.keys()].filter((k) => k.startsWith(`${parentID}|`))
    for (const key of keys) {
      const queue = pending.get(key)
      for (let p = queue?.shift(); p; p = queue?.shift()) {
        if (now() - p.at <= PENDING_TTL_MS) return p
      }
    }
    return undefined
  }

  function onEvent(e: HostEvent): void {
    try {
      const data = e.data
      if (!data) return
      if (e.type === "session.created" && data.parentID) {
        const p = claim(data.parentID, data.agent)
        if (!p) return
        children.set(data.sessionID, {
          agent: p.agent,
          would: p.would,
          model: bareModel(data.model?.id),
        })
        if (children.size > MAX_CHILDREN) {
          const oldest = children.keys().next().value
          if (oldest !== undefined) children.delete(oldest)
        }
      } else if (e.type === "session.model.selected") {
        const child = children.get(data.sessionID)
        if (child && data.model?.id) child.model = bareModel(data.model.id)
      } else if (e.type === "session.step.ended") {
        const child = children.get(data.sessionID)
        if (!child?.model || child.model === child.would) return
        // OpenCode reports no cost on a subscription account, so price the tokens at list.
        const cost =
          typeof data.cost === "number" && data.cost > 0
            ? data.cost
            : data.tokens
              ? listCostUsd(child.model, data.tokens as Usage)
              : undefined
        if (cost === undefined) return
        const saving = savingUsd(cost, child.model, child.would)
        if (saving === undefined || saving === 0) return
        const labels = {
          agent: child.agent,
          model: child.model,
          would: child.would,
        }
        if (saving > 0)
          deps.telemetry.count(
            "model_advisor.shadow.estimated_saving_usd",
            labels,
            saving,
          )
        else
          deps.telemetry.count(
            "model_advisor.shadow.estimated_extra_cost_usd",
            labels,
            -saving,
          )
      }
    } catch (err) {
      log("event_error", {
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    state,
    /** Decides one dispatch; never throws. */
    async decide(d: Dispatch): Promise<Applied | undefined> {
      try {
        return await run(d)
      } catch (err) {
        log("decide_error", {
          message: err instanceof Error ? err.message : String(err),
        })
        return undefined
      }
    },
    onEvent,
    dispose: () => deps.telemetry.dispose(),
  }
}

export type Advisor = ReturnType<typeof createAdvisor>
