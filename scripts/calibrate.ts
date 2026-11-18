/**
 * Calibration CLI (docs/calibration.md).
 *
 *   node --experimental-strip-types scripts/calibrate.ts run [--days 30] [--json]
 *   node --experimental-strip-types scripts/calibrate.ts install [--hour 4] [--minute 15]
 *   node --experimental-strip-types scripts/calibrate.ts uninstall
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

import {
  SCHEDULE_LABEL,
  crontabLine,
  launchdPlist,
  runCalibration,
  type Calibration,
  type Schedule,
} from "../src/calibrate.ts"
import { ConfigStore } from "../src/config.ts"
import { logPath } from "../src/logger.ts"

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const num = (name: string, fallback: number): number => {
  const n = Number(flag(name) ?? fallback)
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`)
  return n
}

const plistPath = () =>
  join(homedir(), "Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`)

const schedule = (): Schedule => ({
  label: SCHEDULE_LABEL,
  command: [
    process.execPath,
    "--experimental-strip-types",
    fileURLToPath(import.meta.url),
    "run",
  ],
  hour: num("hour", 4),
  minute: num("minute", 15),
  logFile: join(dirname(logPath()), "calibrate.log"),
})

const pct = (n: number) => `${Math.round(n * 100)}%`

function print(c: Calibration): void {
  console.log(
    `calibration: ${c.tasks} tasks over ${c.window_days} days, monotonic=${c.backtest.monotonic}`,
  )
  console.log("risk      difficulty level     tasks firstPass retries cost")
  for (const b of c.buckets)
    console.log(
      [
        b.risk.padEnd(9),
        b.difficulty.padEnd(10),
        b.level.padEnd(9),
        String(b.tasks).padEnd(5),
        pct(b.firstPass).padEnd(9),
        String(b.avgRetries).padEnd(7),
        b.costPerTask === null ? "?" : b.costPerTask.toFixed(4),
      ].join(" "),
    )
  if (!c.suggestions.length) console.log("no suggestions")
  for (const s of c.suggestions)
    console.log(`${s.kind}: ${s.path} ${s.from} -> ${s.to} (${s.why})`)
}

async function main(): Promise<void> {
  if (cmd === "run") {
    const c = await runCalibration({
      cfg: new ConfigStore().get().v2,
      days: num("days", 30),
    })
    if (args.includes("--json")) console.log(JSON.stringify(c, null, 2))
    else print(c)
  } else if (cmd === "install") {
    const s = schedule()
    if (process.platform === "darwin") {
      const path = plistPath()
      mkdirSync(dirname(path), { recursive: true })
      mkdirSync(dirname(s.logFile), { recursive: true })
      writeFileSync(path, launchdPlist(s))
      try {
        execFileSync("launchctl", ["unload", path], { stdio: "ignore" })
      } catch {}
      execFileSync("launchctl", ["load", path])
      console.log(`installed ${path}`)
    } else {
      console.log("add this line to your crontab (crontab -e):")
      console.log(crontabLine(s))
    }
  } else if (cmd === "uninstall") {
    if (process.platform === "darwin") {
      const path = plistPath()
      try {
        execFileSync("launchctl", ["unload", path], { stdio: "ignore" })
      } catch {}
      rmSync(path, { force: true })
      console.log(`removed ${path}`)
    } else
      console.log("remove the calibrate line from your crontab (crontab -e)")
  } else {
    console.error(
      "usage: calibrate.ts run [--days N] [--json] | install | uninstall",
    )
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
