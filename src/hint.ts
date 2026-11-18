import type { FactInput, FactName, FactValue, Risk } from "./route-v2.ts"

/**
 * The two markers a dispatch prompt may carry:
 *
 *   [[route: task=1047 risk=high retry=1 files=12 modules=3 kind=edit unknowns=2]]   describes the task
 *   [[advisor: opus]]                                  forces a tier, level or model
 *
 * `tier` is the v1 field and an alias of `risk` for routing v2.
 */
export type Hint = {
  task?: string
  tier?: string
  retry?: number
  files?: number
  risk?: Risk
  modules?: number
  kind?: string
  migration?: boolean
  unknowns?: number
}

const KINDS = new Set(["new", "edit", "refactor", "migration", "delete"])
const TIER_RISK: Record<string, Risk> = {
  t1: "high",
  t2: "medium",
  t3: "low",
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
}

/** A risk word, or a tier alias such as T1, as a risk. */
export const riskOf = (v: string | undefined): Risk | undefined =>
  v ? TIER_RISK[v.trim().toLowerCase()] : undefined

export type Markers = {
  hint: Hint
  /** Raw override text: a tier name or a model fragment. */
  override?: string
  /** The prompt with every marker removed. */
  stripped: string
  found: boolean
}

const HINT = /\[\[\s*route\s*:([^\]\n]*)\]\]/gi
const OVERRIDE = /\[\[\s*advisor\s*:\s*([^\]\n]+?)\s*\]\]/gi
const FIELD = /([a-z_]+)\s*=\s*("[^"]*"|\S+)/gi

const count = (v: string): number | undefined =>
  /^\d{1,9}$/.test(v) ? Number(v) : undefined

function parseFields(body: string): Hint {
  const hint: Hint = {}
  for (const [, key, raw] of body.matchAll(FIELD)) {
    const v = raw.replace(/^"|"$/g, "")
    switch (key.toLowerCase()) {
      case "task":
        if (v) hint.task = v
        break
      case "tier":
        if (v) hint.tier = v.toLowerCase()
        break
      case "retry":
        if (count(v) !== undefined) hint.retry = count(v)
        break
      case "files":
        if (count(v) !== undefined) hint.files = count(v)
        break
      case "modules":
        if (count(v) !== undefined) hint.modules = count(v)
        break
      case "unknowns":
        if (count(v) !== undefined) hint.unknowns = count(v)
        break
      case "risk":
        if (riskOf(v)) hint.risk = riskOf(v)
        break
      case "kind":
        if (KINDS.has(v.toLowerCase())) hint.kind = v.toLowerCase()
        break
      case "migration":
        if (/^(yes|true)$/i.test(v)) hint.migration = true
        else if (/^(no|false)$/i.test(v)) hint.migration = false
        break
    }
  }
  return hint
}

/** A marker alone on its line takes the line with it; an inline one takes its leading space. */
const remove = (text: string, re: RegExp): string => {
  const own = new RegExp(`^[ \\t]*${re.source}[ \\t]*\\r?\\n?`, "gim")
  const inline = new RegExp(` ?${re.source}`, "gi")
  return text.replace(own, "").replace(inline, "")
}

export function parseMarkers(prompt: string): Markers {
  const hintMatch = [...prompt.matchAll(HINT)][0]
  const overrideMatch = [...prompt.matchAll(OVERRIDE)][0]
  return {
    hint: hintMatch ? parseFields(hintMatch[1]) : {},
    ...(overrideMatch ? { override: overrideMatch[1] } : {}),
    stripped: remove(remove(prompt, HINT), OVERRIDE),
    found: !!hintMatch || !!overrideMatch,
  }
}

/** The hint's fields as caller facts; `risk` wins over its `tier` alias. */
export function hintFacts(hint: Hint): FactInput[] {
  const out: FactInput[] = []
  const add = (fact: FactName, value: FactValue | undefined) => {
    if (value !== undefined)
      out.push({ fact, value, kind: "caller", source: "hint" })
  }
  add("risk", hint.risk ?? riskOf(hint.tier))
  add("task", hint.task)
  add("retry", hint.retry)
  add("files", hint.files)
  add("modules", hint.modules)
  add("kind", hint.kind)
  add("migration", hint.migration)
  add("unknowns", hint.unknowns)
  return out
}
