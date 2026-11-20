import { createAdvise } from "./advise.ts"
import { bareModel, type Config } from "./config.ts"
import { wallNow } from "./clock.ts"
import { appendRecord, type AdvisorRecord } from "./decisions.ts"
import { firstSeen } from "./guard.ts"
import { parseMarkers } from "./hint.ts"
import { runJudge, type JudgeFn } from "./judge.ts"
import { log } from "./logger.ts"
import type { Telemetry } from "./otel.ts"
import { listCostUsd, savingUsd, type Usage } from "./pricing.ts"
import type { ConnectorResult, DecisionV2 } from "./route-v2.ts"
import { route, RouteState, skipReason, type RouteInput } from "./router.ts"

export type SessionInfo = { parentID?: string; model?: string }

export type Deps = {
  config: () => Config
  telemetry: Telemetry
  session: (id: string) => Promise<SessionInfo | undefined>
  /** Absent when the host offers no one-shot model call; the judge step is then skipped. */
  judge?: JudgeFn
  now?: () => number
  /** Routing v2 only. Resolves a task's facts from trackers; never throws. */
  connectors?: {
    lookup(task: string, agent: string): Promise<ConnectorResult[]>
  }
  /** Where decisions, alerts and advisor usage go; the decisions file by default. */
  record?: (record: AdvisorRecord) => void
}

export type Dispatch = {
  /** The dispatching session. */
  sessionID: string
  /** The host's id for this tool call; a dispatch seen twice is routed once. */
  callID?: string
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

type Pending = {
  id: string
  agent: string
  would: string
  /** The model the caller asked for; what enforce replaced. */
  caller: string
  at: number
  shadow: boolean
}
type Child = {
  agent: string
  would: string
  caller: string
  model: string
  shadow: boolean
}

/** Waits for `work` at most `ms`, and never rejects. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined)
  })
  try {
    return await Promise.race([work, late])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

const PENDING_TTL_MS = 10 * 60_000
const MAX_CHILDREN = 2000

export function createAdvisor(deps: Deps) {
  // Fractional milliseconds: most decisions take well under one.
  const now = deps.now ?? wallNow
  const state = new RouteState()
  const parents = new Map<string, string | null>()
  const pending = new Map<string, Pending[]>()
  const children = new Map<string, Child>()
  const record = deps.record ?? appendRecord
  let seq = 0
  const stamp = () => new Date(now()).toISOString()

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
    if (d.callID && !firstSeen(`${d.sessionID}|${d.callID}`)) return undefined
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

    if (config.v2.enabled && deps.connectors && markers.hint.task) {
      const limit = config.v2.connectors.length
        ? Math.max(...config.v2.connectors.map((c) => c.timeoutMs))
        : 3000
      const results =
        (await within(
          Promise.resolve(deps.connectors.lookup(markers.hint.task, agent)),
          limit,
        )) ?? []
      const override = results.find((r) => r.override?.level)?.override
      input.v2 = {
        facts: results.flatMap((r) => r.facts),
        override: override && {
          level: override.level,
          detail: override.detail,
        },
        connectors: results.map((r) => {
          const c: DecisionV2["connectors"][number] = {
            id: r.id,
            ok: r.ok,
            ms: r.ms,
            cached: r.cached,
          }
          if (r.error) c.error = r.error
          return c
        }),
      }
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
      if (!judged.ok)
        record({
          v: 1,
          kind: "alert",
          t: stamp(),
          alert: "judge-failed",
          agent,
          session: d.sessionID,
          detail: `${judged.outcome}: ${judged.reason}`.slice(0, 160),
        })
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
    const id = d.callID ?? `${d.sessionID}:${++seq}`
    if (decision.alert) {
      log("alert", {
        alert: decision.alert,
        agent,
        task: markers.hint.task,
        tier: decision.tier,
      })
      record({
        v: 1,
        kind: "alert",
        t: stamp(),
        alert: decision.alert,
        agent,
        session: d.sessionID,
        task: markers.hint.task,
        detail: decision.reason.slice(0, 160),
      })
    }
    record({
      v: 1,
      kind: "decision",
      t: stamp(),
      id,
      session: d.sessionID,
      agent,
      mode: config.mode,
      model: applied,
      would,
      tier: decision.tier,
      source: decision.source,
      rule: decision.rule,
      reason: decision.reason.slice(0, 200),
      task: markers.hint.task,
      ...(decision.v2 ? { v2: decision.v2 } : {}),
    })
    if (decision.v2?.disagreements.length) {
      record({
        v: 1,
        kind: "alert",
        t: stamp(),
        alert: "fact-disagreement",
        agent,
        session: d.sessionID,
        task: markers.hint.task,
        detail: decision.v2.disagreements
          .map(
            (x) =>
              `${x.fact}: ${x.values.map((v) => `${v.source}=${String(v.value)}`).join(" vs ")} → ${String(x.chosen)}`,
          )
          .join("; ")
          .slice(0, 160),
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
      v2: decision.v2,
    })

    const key = `${d.sessionID}|${agent}`
    const queue = pending.get(key) ?? []
    queue.push({
      id,
      agent,
      would,
      caller: callerModel,
      at: end,
      shadow: !enforce,
    })
    pending.set(key, queue.slice(-100))
    if (!enforce) return undefined
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
          caller: p.caller,
          model: bareModel(data.model?.id),
          shadow: p.shadow,
        })
        record({
          v: 1,
          kind: "link",
          t: stamp(),
          session: data.sessionID,
          parent: data.parentID,
          decision: p.id,
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
        // Shadow compares the caller's model with the router's pick; enforce
        // compares the router's applied pick with what the caller asked for.
        const other = child?.shadow ? child.would : child?.caller
        if (!child || !child.model || !other || child.model === other) return
        // OpenCode reports no cost on a subscription account, so price the tokens at list.
        const cost =
          typeof data.cost === "number" && data.cost > 0
            ? data.cost
            : data.tokens
              ? listCostUsd(child.model, data.tokens as Usage)
              : undefined
        if (cost === undefined) return
        const priced = savingUsd(cost, child.model, other)
        if (priced === undefined || priced === 0) return
        const saving = child.shadow ? priced : -priced
        record({
          v: 1,
          kind: "saving",
          t: stamp(),
          session: data.sessionID,
          usd: saving,
        })
        if (!child.shadow) return
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

  const advise = createAdvise({
    config: deps.config,
    telemetry: deps.telemetry,
    record,
    root: (id) => rootOf(id),
    now,
  })

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
    advise,
    dispose: () => deps.telemetry.dispose(),
  }
}

export type Advisor = ReturnType<typeof createAdvisor>
