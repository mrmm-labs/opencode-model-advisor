import { createAdvisor, type Advisor, type SessionInfo } from "./advisor.ts"
import { ConfigStore, type Config } from "./config.ts"
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
}

export function createCore(host: Host, store = new ConfigStore()): Advisor {
  const telemetry = new Telemetry(() => otelTarget(store.get()))
  const config = store.get()
  log("plugin_loaded", {
    mode: config.mode,
    rules: config.rules.length,
    judge: config.judge.enabled && !!host.judge,
    otel: !!otelTarget(config),
  })
  return createAdvisor({ config: () => store.get(), telemetry, ...host })
}
