/**
 * Editing the config file in place, from the TUI.
 *
 * The file is JSONC and its comments are the documentation at the point of use,
 * so writes replace one top-level value and leave every other byte alone. The
 * server re-reads the file on its next stat, so a write takes effect in a
 * running session without a restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { configPath } from "./config.ts"
import { parseJsonc } from "./jsonc.ts"

type Scan = { depth: number; inString: boolean; line: boolean; block: boolean }

/**
 * Walk JSONC tracking what each character is part of.
 *
 * Needed because a key name can appear inside a string or a comment -- this
 * file's comments mention `"strategy"` by name -- and replacing there would
 * corrupt the file rather than edit it.
 */
function scanner(text: string): { depthAt: number[]; codeAt: boolean[] } {
  const depthAt: number[] = Array.from({ length: text.length }, () => 0)
  const codeAt: boolean[] = Array.from({ length: text.length }, () => false)
  const st: Scan = { depth: 0, inString: false, line: false, block: false }
  let escape = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (st.line) {
      if (c === "\n") st.line = false
    } else if (st.block) {
      if (c === "*" && next === "/") {
        st.block = false
        i++
        continue
      }
    } else if (st.inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') st.inString = false
    } else if (c === "/" && next === "/") {
      st.line = true
      i++
      continue
    } else if (c === "/" && next === "*") {
      st.block = true
      i++
      continue
    } else if (c === '"') {
      st.inString = true
    } else if (c === "{" || c === "[") {
      st.depth++
    } else if (c === "}" || c === "]") {
      st.depth--
    }
    depthAt[i] = st.depth
    codeAt[i] = !st.line && !st.block
  }
  return { depthAt, codeAt }
}

/**
 * The same text with one top-level key set to `literal`, comments intact.
 *
 * Returns null when the edit cannot be made safely -- no object to write into,
 * or a key that appears only inside a string or comment. A caller that gets
 * null must not fall back to rewriting the file.
 */
export function setJsoncValue(
  text: string,
  key: string,
  literal: string,
): string | null {
  const { depthAt, codeAt } = scanner(text)
  const needle = `"${key}"`

  for (
    let i = text.indexOf(needle);
    i !== -1;
    i = text.indexOf(needle, i + 1)
  ) {
    // Depth 1 = a direct member of the root object. depthAt is recorded after
    // the character, so the opening quote of a top-level key reads as 1.
    if (!codeAt[i] || depthAt[i] !== 1) continue

    let j = i + needle.length
    while (j < text.length && /\s/.test(text[j]!)) j++
    if (text[j] !== ":") continue
    j++
    while (j < text.length && /\s/.test(text[j]!)) j++

    // The value ends at the next comma belonging to the OBJECT that holds it,
    // or at that object's closing brace.
    //
    // The depth to compare against is the key's, not the value's. Taking it at
    // the value read 2 for an array, which is also the depth of the commas
    // *between its elements* -- so `"accounts": ["a","b","c"]` was truncated at
    // the comma after "a", leaving the rest of the array orphaned and, because
    // no terminator then matched, swallowing the remainder of the file. Scalars
    // were unaffected, which is why every earlier test passed.
    //
    // depthAt records the depth after each character, so a closing brace reads
    // one shallower than its contents: that is why the second test subtracts.
    let end = j
    const keyDepth = depthAt[i] ?? 1
    while (end < text.length) {
      const c = text[end]!
      if (codeAt[end]) {
        if (c === "," && depthAt[end] === keyDepth) break
        if (c === "}" && depthAt[end] === keyDepth - 1) break
      }
      end++
    }
    // A key that never terminates means the scan misread the document. Refusing
    // is the only safe answer: the alternative is what just happened -- writing
    // from here to EOF and destroying everything after it.
    if (end >= text.length) return null
    while (end > j && /\s/.test(text[end - 1]!)) end--

    return text.slice(0, j) + literal + text.slice(end)
  }

  // Not present: add it as the first member, where a reader will see it.
  const open = [...text].findIndex((c, i) => c === "{" && codeAt[i])
  if (open === -1) return null
  return `${text.slice(0, open + 1)}\n  "${key}": ${literal},${text.slice(open + 1)}`
}

export type EditResult = { ok: true } | { ok: false; reason: string }

const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}

/** Pretty JSON for a value that sits one level deep in the file. */
const literalOf = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")

/** Writes a temp file next to the target, then renames it over: a crash never leaves half a config. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, "utf8")
  renameSync(tmp, path)
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return "{}\n"
  }
}

/** Sets one top-level key to a JSON value. */
export function editConfig(
  key: string,
  value: unknown,
  path: string = configPath(),
): EditResult {
  try {
    const after = setJsoncValue(readText(path), key, JSON.stringify(value))
    if (after === null)
      return {
        ok: false,
        reason: `could not edit ${key} safely; file left alone`,
      }
    writeAtomic(path, after)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export const setMode = (mode: "shadow" | "enforce", path?: string) =>
  editConfig("mode", mode, path)

/** Pins `key` (an agent name or `session:<id>`) to a tier; `undefined` removes the pin. */
export function setPin(
  key: string,
  tier: string | undefined,
  path: string = configPath(),
): EditResult {
  try {
    const text = readText(path)
    const pins = asObject(asObject(parseJsonc(text)).pins)
    if (tier === undefined) delete pins[key]
    else pins[key] = tier
    const after = setJsoncValue(text, "pins", literalOf(pins))
    if (after === null)
      return {
        ok: false,
        reason: "could not edit pins safely; file left alone",
      }
    writeAtomic(path, after)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The pins as written in the file, without validation. */
export function readPins(path: string = configPath()): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(
        asObject(asObject(parseJsonc(readText(path))).pins),
      ).filter((e): e is [string, string] => typeof e[1] === "string"),
    )
  } catch {
    return {}
  }
}
