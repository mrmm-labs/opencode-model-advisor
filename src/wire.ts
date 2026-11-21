import {
  createAdvisorTool,
  type AdvisorTool,
  type ToolHost,
} from "./advisor-tool.ts"
import { createAdvisor, type Advisor, type SessionInfo } from "./advisor.ts"
import { wallNow } from "./clock.ts"
import { ConfigStore, type Config } from "./config.ts"
import { createConnectors } from "./connectors.ts"
import { appendRecord } from "./decisions.ts"
import { track } from "./guard.ts"
import { registerHooks } from "./hooks.ts"
import type { JudgeFn } from "./judge.ts"
import { log } from "./logger.ts"
import { Telemetry, type OtelTarget } from "./otel.ts"

/** Config `otel.endpoint`, else the standard env variable, else telemetry is off. */
export function otelTarget(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): OtelTarget | undefined {
  const endpoint = config.otel.endpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT
  return endpoint ? { endpoint, headers: config.otel.headers } : undefined
}

export type Host = {
  session: (id: string) => Promise<SessionInfo | undefined>
  judge?: JudgeFn
  /** Absent when the host cannot read a session or call a model; the advisor tool is then off. */
  advisorTool?: ToolHost
}

/** The advisor plus, when the host supports it, the plugin `advisor` tool and live config. */
export type Core = Advisor & {
  tool?: AdvisorTool
  config: () => Config
}

export function createCore(host: Host, store = new ConfigStore()): Core {
  const telemetry = new Telemetry(() => otelTarget(store.get()))
  const config = store.get()
  log("plugin_loaded", {
    mode: config.mode,
    rules: config.rules.length,
    judge: config.judge.enabled && !!host.judge,
    otel: !!otelTarget(config),
  })
  // Rebuilt when the connector config changes (live reload); the cache goes with it.
  let conn: { key: string; c: ReturnType<typeof createConnectors> } | undefined
  const connectors = {
    lookup(task: string, agent: string) {
      const cfgs = store.get().v2.connectors
      const key = JSON.stringify(cfgs)
      if (conn?.key !== key) conn = { key, c: createConnectors(cfgs) }
      return conn.c.lookup(task, agent)
    },
  }
  const advisor = createAdvisor({
    config: () => store.get(),
    telemetry,
    connectors,
    ...host,
  })
  const untrack = track(advisor)
  const dispose = advisor.dispose
  advisor.dispose = async () => {
    untrack()
    await dispose()
  }
  registerHooks()

  const parents = new Map<string, string | null>()
  const root = async (id: string): Promise<string> => {
    let cur = id
    for (let hop = 0; hop < 10; hop++) {
      let parent = parents.get(cur)
      if (parent === undefined) {
        parent =
          (await host.session(cur).catch(() => undefined))?.parentID ?? null
        parents.set(cur, parent)
      }
      if (!parent) break
      cur = parent
    }
    return cur
  }
  const tool = host.advisorTool
    ? createAdvisorTool({
        config: () => store.get(),
        telemetry,
        record: appendRecord,
        usage: advisor.usage,
        root,
        now: wallNow,
        host: host.advisorTool,
      })
    : undefined
  return Object.assign(advisor, { tool, config: () => store.get() })
}
