/**
 * The decisions stream: what the server plugin tells the TUI.
 *
 * The TUI runs in another process, so the two share a file. One JSON line per
 * routing decision, alert, child session routed and advisor request. No prompt text is
 * ever written; the reason is capped to a short string.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { logPath } from "./logger.ts"

export type DecisionRecord = {
  v: 1
  kind: "decision"
  t: string
  id: string
  /** The dispatching session. */
  session: string
  agent: string
  mode: "shadow" | "enforce"
  /** The model applied, or the caller's in shadow. */
  model: string
  /** The model the router chose. */
  would: string
  tier: string
  source: string
  rule?: string
  reason: string
  task?: string
}

/** Ties a child session to the decision that routed it. */
export type LinkRecord = {
  v: 1
  kind: "link"
  t: string
  session: string
  parent: string
  decision: string
}

export type AlertRecord = {
  v: 1
  kind: "alert"
  t: string
  alert: string
  agent?: string
  session?: string
  task?: string
  detail?: string
}

/** What the advisor tool did for one request of a session. */
export type AdviceRecord = {
  v: 1
  kind: "advice"
  t: string
  session: string
  agent: string
  attached: boolean
  /** Shadow mode: the policy would have attached it. */
  would?: boolean
  calls: number
  inTokens: number
  outTokens: number
  cost: number
  refused?: boolean
}

export type AdvisorRecord =
  | DecisionRecord
  | LinkRecord
  | AlertRecord
  | AdviceRecord

const KINDS = new Set(["decision", "link", "alert", "advice"])
const MAX_BYTES = 256_000
const CHECK_EVERY = 50
const KEEP = 2000

export function decisionsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MODEL_ADVISOR_DECISIONS)
    return env.OPENCODE_MODEL_ADVISOR_DECISIONS
  return join(dirname(logPath(env)), "decisions.jsonl")
}

const writes = new Map<string, number>()

function rotate(path: string): void {
  try {
    if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
  } catch {}
}

/** Appends one line; never throws. Bounded: the file rolls to `.1` past 256 KB. */
export function appendRecord(
  record: AdvisorRecord,
  path: string = decisionsPath(),
): void {
  try {
    const n = writes.get(path)
    if (n === undefined) {
      mkdirSync(dirname(path), { recursive: true })
      rotate(path)
    } else if (n % CHECK_EVERY === 0) rotate(path)
    writes.set(path, (n ?? 0) + 1)
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {}
}

export function parseRecords(text: string): AdvisorRecord[] {
  const out: AdvisorRecord[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as AdvisorRecord
      if (r && KINDS.has(r.kind) && typeof r.t === "string") out.push(r)
    } catch {}
  }
  return out
}

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

/** Oldest first. Reads the rolled file too, so a roll does not blank the view. */
export function readRecords(path: string = decisionsPath()): AdvisorRecord[] {
  return parseRecords(readText(`${path}.1`) + readText(path)).slice(-KEEP)
}

/** Re-reads only when the file changed (one stat per call). */
export class RecordReader {
  private stamp = ""
  private records: AdvisorRecord[] = []
  private path: () => string

  constructor(path: () => string = () => decisionsPath()) {
    this.path = path
  }

  read(): AdvisorRecord[] {
    const path = this.path()
    let stamp = "missing"
    try {
      const s = statSync(path)
      stamp = `${path}:${s.mtimeMs}:${s.size}`
    } catch {}
    if (stamp !== this.stamp) {
      this.stamp = stamp
      this.records = readRecords(path)
    }
    return this.records
  }
}
