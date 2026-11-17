/**
 * Registers the advisor on opencode-claude-accounts' request path.
 *
 * The registry lives on globalThis and either plugin may load first, so both
 * sides create it with `??=`. One registration per process: every project
 * instance loads this plugin, and each would otherwise attach the advisor again.
 * The hooks call whichever instance is alive, so closing the one that
 * registered them does not switch advising off.
 */
import type { Advisor } from "./advisor.ts"
import type { HookContext, HookRequest } from "./advise.ts"
import { claimOnce, liveInstance } from "./guard.ts"
import { log } from "./logger.ts"

type Registry = {
  before: Array<(req: HookRequest) => void | Promise<void>>
  response: Array<
    (res: Response, ctx: HookContext) => Response | Promise<Response>
  >
}

const IDLE_CHECK_MS = 60_000

export function registerHooks(): void {
  if (!claimOnce("hooks")) return
  const g = globalThis as { __claudeAccountsHooks?: Registry }
  const registry = (g.__claudeAccountsHooks ??= { before: [], response: [] })
  let called = false

  registry.before.push(async (req) => {
    called = true
    try {
      await liveInstance<Advisor>()?.advise.before(req)
    } catch (err) {
      log("advisor_error", {
        phase: "before",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  registry.response.push(async (res, ctx) => {
    try {
      return (await liveInstance<Advisor>()?.advise.response(res, ctx)) ?? res
    } catch (err) {
      log("advisor_error", {
        phase: "response",
        message: err instanceof Error ? err.message : String(err),
      })
      return res
    }
  })
  log("advisor_hooks_registered")

  const timer = setTimeout(() => {
    if (!called)
      log("advisor_hooks_idle", {
        message:
          "no request reached the advisor hooks; advising needs opencode-claude-accounts with request hooks",
      })
  }, IDLE_CHECK_MS)
  ;(timer as { unref?: () => void }).unref?.()
}
