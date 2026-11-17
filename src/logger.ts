import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const MAX_BYTES = 1_000_000

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_LOG) return env.OPENCODE_MODEL_ADVISOR_LOG
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "model-advisor", "advisor.log")
}

let ready: string | undefined

/** Appends one JSON line; logging never throws. Nothing is written to stdout or stderr, which the TUI owns. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const path = logPath()
    if (ready !== path) {
      mkdirSync(dirname(path), { recursive: true })
      try {
        if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
      } catch {}
      ready = path
    }
    appendFileSync(
      path,
      `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`,
    )
  } catch {}
}
