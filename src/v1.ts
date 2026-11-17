/**
 * OpenCode 1 entry: a `tool.execute.before` hook on the `task` tool.
 *
 * V1 has no one-shot model call for plugins, so the judge is not available here
 * and a dispatch no rule matches gets the default tier. V1 events carry no
 * per-step cost either, so the shadow saving estimate is V2 only.
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"

import { log } from "./logger.ts"
import { createCore } from "./wire.ts"

type TaskArgs = {
  subagent_type?: string
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
    session: async (id) => {
      const result = (await client.session.get({ path: { id } } as never)) as {
        data?: { parentID?: string }
      }
      return { parentID: result?.data?.parentID }
    },
  })
  process.once?.("beforeExit", () => void advisor.dispose())

  return {
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
