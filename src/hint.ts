/**
 * The two markers a dispatch prompt may carry:
 *
 *   [[route: task=1047 tier=high retry=1 files=12]]   describes the task
 *   [[advisor: opus]]                                  forces a tier or model
 */
export type Hint = {
  task?: string
  tier?: string
  retry?: number
  files?: number
}

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
