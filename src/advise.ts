/**
 * The advisor tool: attached to a cheaper model's requests so it can consult a
 * stronger one, with the advisor's blocks filtered out of the response.
 *
 * It runs as hooks on opencode-claude-accounts' request path (the only place
 * the Messages body and response stream are reachable from a plugin).
 */
import { bareModel, type Config } from "./config.ts"
import type { AlertRecord, AdviceRecord, AdvisorRecord } from "./decisions.ts"
import { JUDGE_MARK } from "./judge.ts"
import { log } from "./logger.ts"
import type { Telemetry } from "./otel.ts"
import { skipReason } from "./router.ts"
import {
  filterMessage,
  filterStream,
  type AdvisorUsage,
} from "./stream-filter.ts"
import { advisorCost, advisorRow, type Usage } from "./usage.ts"

export const BETA = "advisor-tool-2026-03-01"
export const TOOL_TYPE = "advisor_20260301"
export const SYSTEM_LINE =
  "You have an advisor tool backed by a stronger model. Consult it before committing to an approach, when an error repeats, and before declaring the task done."

export const TOOL_SYSTEM_LINE =
  "You have an `advisor` tool backed by a stronger model. Call it with one focused question before committing to an approach, when an error repeats, and before declaring the task done."
/** Opens every advisor-tool prompt; the policy leaves those requests alone. */
export const ADVISOR_MARK = "You are the advisor to a coding agent"

export type HookRequest = {
  url: string
  body: Record<string, unknown>
  headers: Headers
  model: string
  agent?: string
  sessionID?: string
}
export type HookContext = HookRequest & {
  resend: (body: Record<string, unknown>) => Promise<Response>
}

type Json = Record<string, any>

/** Characters per token: a rough, model-independent estimate of context size. */
const CHARS_PER_TOKEN = 4
const MAX_TRACKED = 500

export type AdviseDeps = {
  config: () => Config
  telemetry: Telemetry
  record: (record: AdvisorRecord) => void
  usage: Usage
  root: (session: string) => Promise<string>
  now: () => number
}

/** Position of a model on the ladder: a tier whose model id matches, else the tier name in the id. */
export function rankOf(model: string, config: Config): number | undefined {
  const bare = bareModel(model).toLowerCase()
  const at = config.ladder.findIndex(
    (t) =>
      bareModel(config.tiers[t]).toLowerCase() === bare ||
      bare.includes(t.toLowerCase()),
  )
  return at < 0 ? undefined : at
}

export type AdvisorImpl = "native" | "tool" | "none"

const isAnthropic = (model: string): boolean => {
  const slash = model.indexOf("/")
  return slash < 0
    ? /^claude/i.test(model)
    : model.slice(0, slash).toLowerCase() === "anthropic"
}

/** The advisor's model: the advisor level's model with routing v2 on, else `advisor.model`. */
export const advisorModelOf = (config: Config): string | undefined =>
  config.v2.enabled
    ? config.v2.levels[config.v2.advisor.level]?.model
    : config.advisor.model

/** Position of a model on the v2 level ladder: a level's model id, else the level name in the id. */
export function levelRank(model: string, config: Config): number | undefined {
  const { levels, levelOrder } = config.v2
  const bare = bareModel(model).toLowerCase()
  const at = levelOrder.findIndex(
    (l) =>
      bareModel(levels[l]?.model).toLowerCase() === bare ||
      bare.includes(l.toLowerCase()),
  )
  return at < 0 ? undefined : at
}

/**
 * How the advisor reaches this executor: the native server tool, the plugin
 * tool, or not at all. With v2 off it is the v1 rule (native when the executor
 * ranks below the advisor tier); with v2 on, levels decide and a pairing the API
 * refused (`refused`, "executor|advisor" bare ids) falls back to the tool.
 */
export function advisorImpl(
  executor: string,
  config: Config,
  refused: ReadonlySet<string> = new Set(),
): AdvisorImpl {
  if (!config.advisor.enabled) return "none"
  if (!config.v2.enabled) {
    const mine = rankOf(executor, config)
    const theirs = rankOf(config.advisor.model, config)
    return mine === undefined || theirs === undefined || mine >= theirs
      ? "none"
      : "native"
  }
  const advisor = advisorModelOf(config)
  const theirs = config.v2.levelOrder.indexOf(config.v2.advisor.level)
  const mine = levelRank(executor, config)
  if (!advisor || theirs < 0 || mine === undefined || mine >= theirs)
    return "none"
  const { impl } = config.v2.advisor
  if (impl !== "auto") return impl
  const pair = `${bareModel(executor)}|${bareModel(advisor)}`
  return isAnthropic(executor) && isAnthropic(advisor) && !refused.has(pair)
    ? "native"
    : "tool"
}

/** True when the plugin `advisor` tool should be offered to this executor right now. */
export const toolActive = (
  executor: string | undefined,
  agent: string | undefined,
  config: Config,
  refused?: ReadonlySet<string>,
): boolean =>
  config.v2.enabled &&
  config.mode === "enforce" &&
  !skipReason(agent, config) &&
  !!executor &&
  advisorImpl(executor, config, refused) === "tool"

export const estimateTokens = (body: Json): number =>
  Math.ceil(JSON.stringify(body).length / CHARS_PER_TOKEN)

const toolsOf = (body: Json): Json[] =>
  Array.isArray(body.tools) ? body.tools : []

export const hasAdvisor = (body: Json): boolean =>
  toolsOf(body).some((t) => t?.type === TOOL_TYPE)

export function mergeBeta(headers: Headers, add: boolean): void {
  const parts = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== BETA)
  if (add) parts.push(BETA)
  if (parts.length) headers.set("anthropic-beta", parts.join(","))
  else headers.delete("anthropic-beta")
}

function addSystemLine(body: Json): void {
  const system = body.system
  if (typeof system === "string") {
    if (!system.includes(SYSTEM_LINE))
      body.system = `${system}\n\n${SYSTEM_LINE}`
  } else if (Array.isArray(system) && system.length > 0) {
    const last = system.findLast((b) => b?.type === "text")
    if (last && !String(last.text).includes(SYSTEM_LINE))
      last.text = `${last.text}\n\n${SYSTEM_LINE}`
    else if (!last) system.push({ type: "text", text: SYSTEM_LINE })
  } else body.system = [{ type: "text", text: SYSTEM_LINE }]
}

function dropSystemLine(body: Json, line = SYSTEM_LINE): void {
  const strip = (t: string) => t.replace(`\n\n${line}`, "").replace(line, "")
  if (typeof body.system === "string") body.system = strip(body.system)
  else if (Array.isArray(body.system))
    body.system = body.system
      .map((b: Json) =>
        b?.type === "text" ? { ...b, text: strip(String(b.text)) } : b,
      )
      .filter((b: Json) => b?.type !== "text" || b.text !== "")
}

/** A copy of the body without the advisor tool and its system line. */
export function withoutAdvisor(body: Json): Json {
  const copy = structuredClone(body)
  if (Array.isArray(copy.tools)) {
    copy.tools = copy.tools.filter((t: Json) => t?.type !== TOOL_TYPE)
    if (copy.tools.length === 0) delete copy.tools
  }
  dropSystemLine(copy)
  return copy
}

/** Removes the plugin `advisor` function tool (not the native one) and its system line, in place. */
function dropPluginTool(body: Json): void {
  if (!Array.isArray(body.tools)) return
  const kept = body.tools.filter(
    (t: Json) => !(t?.name === "advisor" && t?.type !== TOOL_TYPE),
  )
  if (kept.length === body.tools.length) return
  if (kept.length) body.tools = kept
  else delete body.tools
  dropSystemLine(body, TOOL_SYSTEM_LINE)
}

/** True when the last message starts a turn rather than returning tool results. */
function startsTurn(body: Json): boolean {
  const last = Array.isArray(body.messages)
    ? body.messages[body.messages.length - 1]
    : undefined
  if (!last || last.role !== "user") return false
  return !(
    Array.isArray(last.content) &&
    last.content.some((b: Json) => b?.type === "tool_result")
  )
}

const REFUSAL = /advisor|tool type|beta/i

export function createAdvise(deps: AdviseDeps) {
  /** Executor/advisor pairs the API refused; never attached again in this process. */
  const refused = new Set<string>()
  const turns = new Map<string, { steps: number; alerted: boolean }>()
  const wouldSeen = new Set<string>()

  const stamp = () => new Date(deps.now()).toISOString()

  function alert(r: Omit<AlertRecord, "v" | "kind" | "t">): void {
    deps.record({ v: 1, kind: "alert", t: stamp(), ...r })
    log("alert", r)
  }

  /** Long turn, enforce mode, executor below the advisor, no advisor attached. */
  function watchSteps(req: HookRequest, config: Config, attached: boolean) {
    if (!req.sessionID || !req.agent) return
    const turn = turns.get(req.sessionID) ?? { steps: 0, alerted: false }
    if (startsTurn(req.body)) {
      turn.steps = 0
      turn.alerted = false
    }
    turn.steps++
    turns.delete(req.sessionID)
    turns.set(req.sessionID, turn)
    if (turns.size > MAX_TRACKED) {
      const oldest = turns.keys().next().value
      if (oldest !== undefined) turns.delete(oldest)
    }
    if (
      attached ||
      turn.alerted ||
      turn.steps <= config.advisor.alertSteps ||
      config.mode !== "enforce"
    )
      return
    turn.alerted = true
    alert({
      alert: "long-turn-no-advisor",
      agent: req.agent,
      session: req.sessionID,
      detail: `${turn.steps} steps on ${bareModel(req.model)} with no advisor`,
    })
  }

  function before(req: HookRequest): void {
    const config = deps.config()
    if (config.v2.enabled && !toolActive(req.model, req.agent, config, refused))
      dropPluginTool(req.body)
    const a = config.advisor
    if (!a.enabled || !req.agent || skipReason(req.agent, config)) return
    if (advisorImpl(req.model, config, refused) !== "native") return
    const advisorModel = advisorModelOf(config) as string
    const text = JSON.stringify(req.body)
    if (text.includes(JUDGE_MARK) || text.includes(ADVISOR_MARK)) return
    const pair = `${bareModel(req.model)}|${bareModel(advisorModel)}`
    const tooBig = text.length / CHARS_PER_TOKEN > a.maxContextTokens
    const ok = !refused.has(pair) && !tooBig

    if (config.mode !== "enforce") {
      if (ok && req.sessionID && !wouldSeen.has(req.sessionID)) {
        wouldSeen.add(req.sessionID)
        if (wouldSeen.size > MAX_TRACKED) wouldSeen.clear()
        deps.telemetry.count("model_advisor.advisor.would_attach", {
          agent: req.agent,
        })
        deps.record({
          v: 1,
          kind: "advice",
          t: stamp(),
          session: req.sessionID,
          agent: req.agent,
          attached: false,
          would: true,
          calls: 0,
          inTokens: 0,
          outTokens: 0,
          cost: 0,
        })
      }
      return
    }
    watchSteps(req, config, ok)
    if (!ok) return

    const tools = toolsOf(req.body)
    if (!hasAdvisor(req.body)) {
      req.body.tools = [
        ...tools,
        {
          type: TOOL_TYPE,
          name: "advisor",
          model: advisorModel,
          max_uses: a.maxUses,
        },
      ]
    }
    mergeBeta(req.headers, true)
    addSystemLine(req.body)
  }

  async function record(
    req: HookRequest,
    config: Config,
    usage: AdvisorUsage,
    start: number,
  ): Promise<void> {
    const agent = req.agent ?? "unknown"
    const model = usage.model ?? (advisorModelOf(config) as string)
    const priced = usage.perCall.map((c) => {
      const m = c.model ?? model
      return { ...c, model: m, cost: advisorCost(m, c) }
    })
    const cost = priced.reduce((n, c) => n + c.cost, 0)
    for (const c of priced)
      deps.usage.add(
        advisorRow(c, { agent, session: req.sessionID }, deps.now()),
      )
    deps.telemetry.count("model_advisor.advisor.calls", { agent }, usage.calls)
    deps.telemetry.count(
      "model_advisor.advisor.tokens",
      { agent, kind: "input" },
      usage.inputTokens,
    )
    deps.telemetry.count(
      "model_advisor.advisor.tokens",
      { agent, kind: "output" },
      usage.outputTokens,
    )
    deps.telemetry.count("model_advisor.advisor.cost_usd", { agent }, cost)
    deps.telemetry.span({
      name: `advisor ${agent}`,
      session: req.sessionID,
      traceSession: req.sessionID ? await deps.root(req.sessionID) : undefined,
      start,
      end: deps.now(),
      attrs: {
        "opencode.agent": agent,
        "advisor.attached": true,
        "advisor.model": model,
        "advisor.calls": usage.calls,
        "advisor.input_tokens": usage.inputTokens,
        "advisor.output_tokens": usage.outputTokens,
        "advisor.cost_usd": cost,
      },
    })
    if (req.sessionID) {
      deps.record({
        v: 1,
        kind: "advice",
        t: stamp(),
        session: req.sessionID,
        agent,
        attached: true,
        calls: usage.calls,
        inTokens: usage.inputTokens,
        outTokens: usage.outputTokens,
        cost,
      })
    }
  }

  async function response(res: Response, ctx: HookContext): Promise<Response> {
    const attached =
      hasAdvisor(ctx.body) ||
      (ctx.headers.get("anthropic-beta") ?? "").includes(BETA)
    if (!attached) return res
    const config = deps.config()
    const start = deps.now()

    if (res.status === 400) {
      const text = await res
        .clone()
        .text()
        .catch(() => "")
      if (!REFUSAL.test(text)) return res
      refused.add(
        `${bareModel(ctx.model)}|${bareModel(advisorModelOf(config))}`,
      )
      mergeBeta(ctx.headers, false)
      deps.telemetry.count("model_advisor.advisor.refusals", {
        agent: ctx.agent ?? "unknown",
      })
      if (ctx.sessionID)
        deps.record({
          v: 1,
          kind: "advice",
          t: stamp(),
          session: ctx.sessionID,
          agent: ctx.agent ?? "unknown",
          attached: false,
          refused: true,
          calls: 0,
          inTokens: 0,
          outTokens: 0,
          cost: 0,
        })
      alert({
        alert: "advisor-refused",
        agent: ctx.agent,
        session: ctx.sessionID,
        detail: text.slice(0, 160),
      })
      return ctx.resend(withoutAdvisor(ctx.body))
    }
    if (!res.ok || !res.body) return res

    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    const init = { status: res.status, statusText: res.statusText, headers }
    if ((res.headers.get("content-type") ?? "").includes("event-stream")) {
      return new Response(
        filterStream(res.body, (usage) => {
          if (usage.calls > 0) void record(ctx, config, usage, start)
        }),
        init,
      )
    }
    try {
      const message = (await res.clone().json()) as Json
      const usage = filterMessage(message)
      if (usage.calls > 0) void record(ctx, config, usage, start)
      return new Response(JSON.stringify(message), init)
    } catch (err) {
      log("advisor_filter_error", {
        message: err instanceof Error ? err.message : String(err),
      })
      return res
    }
  }

  return { before, response }
}

export type Advise = ReturnType<typeof createAdvise>
export type { AdviceRecord }
