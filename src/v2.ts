/**
 * OpenCode 2 entry: a tool hook on the subagent dispatch, an event
 * subscription for the shadow saving estimate, and `ctx.generate` for the judge.
 */
import type { Plugin as V2Plugin } from "@opencode/plugin"

import { TOOL_SYSTEM_LINE, toolActive } from "./advise.ts"
import { TOOL_DESCRIPTION, TOOL_NAME, v2Host } from "./advisor-tool.ts"
import type { HostEvent } from "./advisor.ts"
import { log } from "./logger.ts"
import { createCore } from "./wire.ts"

type Context = Parameters<V2Plugin.Plugin["setup"]>[0]

type DispatchInput = {
  agent?: string
  prompt?: string
  model?: string
  sessionID?: string
}

export async function setup(ctx: Context) {
  const advisor = createCore({
    advisorTool: v2Host(ctx as never),
    session: async (id) => {
      const info = await ctx.session.get({ sessionID: id } as never)
      const i = info as { parentID?: string; model?: { id?: string } }
      return { parentID: i?.parentID, model: i?.model?.id }
    },
    judge: async ({ model, prompt }) =>
      (await ctx.generate.text({ prompt, model } as never)).text,
  })

  await ctx.tool.hook("execute.before", async (event) => {
    try {
      if (!/^(subagent|task)$/.test(event.tool)) return
      const input = event.input as DispatchInput | undefined
      if (!input || typeof input.prompt !== "string") return
      const applied = await advisor.decide({
        sessionID: event.sessionID,
        callID: (event as { id?: string }).id,
        agent: input.agent,
        prompt: input.prompt,
        model: typeof input.model === "string" ? input.model : undefined,
        continuing: !!input.sessionID,
      })
      if (applied?.model) input.model = applied.model
      if (applied?.prompt !== undefined) input.prompt = applied.prompt
    } catch (err) {
      log("hook_error", {
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Registered only when routing v2 is on at load: tool catalogs can list a registered
  // tool even where the context hook below removes it, so v2 off means no tool at all.
  const run = advisor.config().v2.enabled ? advisor.tool : undefined
  if (run) {
    await ctx.tool.transform((editor) =>
      editor.add({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "What you need advice on",
            },
          },
          required: ["question"],
        },
        execute: async (
          input: { question?: string },
          c: { sessionID: string; agent: string; signal: AbortSignal },
        ) => ({
          content: await run.execute(input.question ?? "", {
            sessionID: c.sessionID,
            agent: c.agent,
            signal: c.signal,
          }),
        }),
      } as never),
    )
    // The tool and its system line are offered only to sessions the advisor serves through it.
    await ctx.session.hook("context", (c) => {
      if (
        toolActive(
          `${c.model.providerID}/${c.model.id}`,
          c.agent,
          advisor.config(),
        )
      ) {
        if (!c.system.some((p) => p.text.includes(TOOL_SYSTEM_LINE)))
          c.system.push({ type: "text", text: TOOL_SYSTEM_LINE })
      } else delete c.tools[TOOL_NAME]
    })
  }

  const abort = new AbortController()
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: abort.signal,
        } as never)) {
          advisor.onEvent(event as unknown as HostEvent)
        }
      } catch (err) {
        if (abort.signal.aborted) return
        log("event_stream_error", {
          message: err instanceof Error ? err.message : String(err),
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 1000).unref?.())
    }
  })()

  return async () => {
    abort.abort()
    await advisor.dispose()
  }
}
