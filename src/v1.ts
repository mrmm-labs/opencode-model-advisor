/**
 * OpenCode 1 entry: a `tool.execute.before` hook on the `task` tool.
 *
 * V1 has no one-shot model call for plugins, so the judge is not available here
 * and a dispatch no rule matches gets the default tier. V1 events carry no
 * per-step cost either, so the shadow saving estimate is V2 only.
 */
import type { Hooks, Plugin as V1Plugin } from "@opencode-ai/plugin"

import { TOOL_SYSTEM_LINE, toolActive } from "./advise.ts"
import { TOOL_DESCRIPTION, TOOL_NAME, v1Host } from "./advisor-tool.ts"
import { log } from "./logger.ts"
import { createCore, type Core } from "./wire.ts"

const MAX_AGENTS = 500

/**
 * The plugin `advisor` tool, only when routing v2 is on at load: V1 offers a
 * tool to every session and cannot gate it per session, so an inert definition
 * would cost prompt tokens on every request. Needs `@opencode-ai/plugin` at
 * runtime (for the argument schema); without it the tool is skipped.
 */
async function advisorTool(core: Core): Promise<Hooks["tool"]> {
  const run = core.tool
  if (!run || !core.config().v2.enabled) return undefined
  try {
    const { tool } = await import("@opencode-ai/plugin")
    return {
      [TOOL_NAME]: tool({
        description: TOOL_DESCRIPTION,
        args: {
          question: tool.schema.string().describe("What you need advice on"),
        },
        execute: (args, ctx) =>
          run.execute(args.question, {
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            signal: ctx.abort,
          }),
      }),
    }
  } catch (err) {
    log("advisor_tool_unavailable", {
      message: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

type TaskArgs = {
  subagent_type?: string
  description?: string
  prompt?: string
  model?: string | { providerID?: string; modelID?: string }
  session_id?: string
  task_id?: string
}

const modelString = (m: TaskArgs["model"]): string | undefined =>
  typeof m === "string"
    ? m
    : m?.modelID
      ? `${m.providerID ?? "anthropic"}/${m.modelID}`
      : undefined

export const server: V1Plugin = async ({ client }) => {
  const advisor = createCore({
    advisorTool: v1Host(client as never),
    session: async (id) => {
      const result = (await client.session.get({ path: { id } } as never)) as {
        data?: { parentID?: string }
      }
      return { parentID: result?.data?.parentID }
    },
  })
  process.once?.("beforeExit", () => void advisor.dispose())

  // The system transform sees the session and model but not the agent.
  const agents = new Map<string, string>()

  return {
    tool: await advisorTool(advisor),
    "chat.message": async (input) => {
      if (!input.agent) return
      agents.delete(input.sessionID)
      agents.set(input.sessionID, input.agent)
      if (agents.size > MAX_AGENTS) {
        const oldest = agents.keys().next().value
        if (oldest !== undefined) agents.delete(oldest)
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const model = `${input.model.providerID}/${input.model.id}`
      const agent = input.sessionID ? agents.get(input.sessionID) : undefined
      if (
        toolActive(model, agent, advisor.config()) &&
        !output.system.some((t) => t.includes(TOOL_SYSTEM_LINE))
      )
        output.system.push(TOOL_SYSTEM_LINE)
    },
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool !== "task") return
        const args = output.args as TaskArgs | undefined
        if (!args || typeof args.prompt !== "string") return
        const applied = await advisor.decide({
          sessionID: input.sessionID,
          callID: (input as { callID?: string }).callID,
          agent: args.subagent_type,
          prompt: args.prompt,
          description: args.description,
          model: modelString(args.model),
          continuing: !!(args.session_id || args.task_id),
        })
        if (applied?.model) args.model = applied.model
        if (applied?.prompt !== undefined) args.prompt = applied.prompt
      } catch (err) {
        log("hook_error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
