/**
 * Editing the config file in place, from the TUI.
 *
 * The file is JSONC and its comments are the documentation at the point of use,
 * so writes replace one top-level value and leave every other byte alone. The
 * server re-reads the file on its next stat, so a write takes effect in a
 * running session without a restart.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

import { buildConfig, configPath } from "./config.ts"
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

export type Path = (string | number)[]

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r"

/** Skips whitespace and comments. */
function skipTrivia(t: string, from: number): number {
  let i = from
  for (;;) {
    while (i < t.length && isSpace(t[i])) i++
    if (t[i] === "/" && t[i + 1] === "/") {
      while (i < t.length && t[i] !== "\n") i++
    } else if (t[i] === "/" && t[i + 1] === "*") {
      const end = t.indexOf("*/", i + 2)
      if (end < 0) return t.length
      i = end + 2
    } else return i
  }
}

/** Index after the closing quote of the string opening at `i`, or -1. */
function stringEnd(t: string, i: number): number {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === "\\") j++
    else if (t[j] === '"') return j + 1
  }
  return -1
}

/** Index after the value starting at `i`, or -1 when it is malformed. */
function valueEnd(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return stringEnd(t, i)
  if (c === "{" || c === "[") {
    let depth = 0
    for (let j = i; j < t.length; j++) {
      const d = t[j]
      if (d === '"') {
        const e = stringEnd(t, j)
        if (e < 0) return -1
        j = e - 1
      } else if (d === "/" && (t[j + 1] === "/" || t[j + 1] === "*")) {
        j = skipTrivia(t, j) - 1
      } else if (d === "{" || d === "[") depth++
      else if ((d === "}" || d === "]") && --depth === 0) return j + 1
    }
    return -1
  }
  let j = i
  while (j < t.length && !",]}/ \t\r\n".includes(t[j]!)) j++
  return j > i ? j : -1
}

type Item = {
  key?: string
  /** Where the member (key, or element) starts. */
  from: number
  start: number
  end: number
  /** The comma after the member, or -1. */
  comma: number
}

/** The members of the object or array opening at `at`; null when the text is malformed. */
function members(
  t: string,
  at: number,
): { object: boolean; items: Item[]; close: number } | null {
  const object = t[at] === "{"
  const closer = object ? "}" : "]"
  const items: Item[] = []
  let i = at + 1
  for (;;) {
    i = skipTrivia(t, i)
    if (i >= t.length) return null
    if (t[i] === closer) return { object, items, close: i }
    const from = i
    let key: string | undefined
    if (object) {
      if (t[i] !== '"') return null
      const ke = stringEnd(t, i)
      if (ke < 0) return null
      try {
        key = JSON.parse(t.slice(i, ke)) as string
      } catch {
        return null
      }
      i = skipTrivia(t, ke)
      if (t[i] !== ":") return null
      i = skipTrivia(t, i + 1)
    }
    const end = valueEnd(t, i)
    if (end < 0) return null
    const after = skipTrivia(t, end)
    const comma = t[after] === "," ? after : -1
    if (comma < 0 && t[after] !== closer) return null
    items.push({ key, from, start: i, end, comma })
    i = comma < 0 ? after : comma + 1
  }
}

const lineStart = (t: string, pos: number) => t.lastIndexOf("\n", pos - 1) + 1
const leading = (t: string, pos: number) =>
  /^[ \t]*/.exec(t.slice(lineStart(t, pos)))![0]
const startsLine = (t: string, pos: number) =>
  t.slice(lineStart(t, pos), pos).trim() === ""

const literalAt = (value: unknown, indent: string) =>
  JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`)

/** `value` wrapped in one object per remaining key; null when a key is an array index. */
function nest(path: Path, value: unknown): unknown {
  let out = value
  for (const seg of path.toReversed()) {
    if (typeof seg !== "string") return null
    out = { [seg]: out }
  }
  return out
}

/** Removes the line `at` sits on when nothing but whitespace is left on it. */
function dropBlankLine(t: string, at: number): string {
  const from = lineStart(t, at)
  let to = t.indexOf("\n", at)
  to = to < 0 ? t.length : to
  if (t.slice(from, to).trim() !== "") return t
  return t.slice(0, from) + t.slice(Math.min(to + 1, t.length))
}

/**
 * The same text with the value at `path` set, or removed when `value` is
 * undefined; comments and every other byte stay. An object key that is missing
 * is created, along with missing parent objects. An array element is replaced
 * by index, or appended at index === length.
 *
 * Returns null when the edit cannot be made safely: the text is malformed, a
 * parent is not a container of the right kind, or the path needs an array that
 * is not there. A caller that gets null must not rewrite the file around it.
 */
export function setJsoncPath(
  text: string,
  path: Path,
  value: unknown,
): string | null {
  if (path.length === 0) return null
  let at = skipTrivia(text, 0)
  for (let depth = 0; ; depth++) {
    if (text[at] !== "{" && text[at] !== "[") return null
    const m = members(text, at)
    if (!m) return null
    const seg = path[depth]!
    if (m.object !== (typeof seg === "string")) return null
    const last = depth === path.length - 1
    const index = m.object
      ? m.items.findIndex((i) => i.key === seg)
      : (seg as number)
    const item = m.items[index]

    if (item) {
      if (!last) {
        at = item.start
        continue
      }
      if (value !== undefined) {
        const lit = literalAt(value, leading(text, item.start))
        return text.slice(0, item.start) + lit + text.slice(item.end)
      }
      let from = item.from
      let to = item.end
      if (item.comma >= 0) to = item.comma + 1
      else if (index > 0) from = m.items[index - 1]!.comma
      const out = text.slice(0, from) + text.slice(to)
      return dropBlankLine(out, from)
    }

    if (value === undefined) return m.object ? text : null
    const rest = path.slice(depth + 1)
    const made = nest(rest, value)
    if (made === null && rest.length > 0) return null
    const inner =
      m.items[0] && startsLine(text, m.items[0].from)
        ? leading(text, m.items[0].from)
        : `${leading(text, at)}  `
    const closeIndent = leading(text, at)
    const emptyInside = text.slice(at + 1, m.close).trim() === ""

    if (m.object) {
      const member = `${JSON.stringify(seg)}: ${literalAt(made, inner)}`
      if (m.items.length > 0)
        return `${text.slice(0, at + 1)}\n${inner}${member},${text.slice(at + 1)}`
      if (!emptyInside)
        return `${text.slice(0, at + 1)}\n${inner}${member}${text.slice(at + 1)}`
      return `${text.slice(0, at + 1)}\n${inner}${member}\n${closeIndent}${text.slice(m.close)}`
    }

    if (index !== m.items.length) return null
    const lit = literalAt(made, inner)
    const prev = m.items.at(-1)
    if (!prev) {
      if (!emptyInside) return null
      return `${text.slice(0, at + 1)}\n${inner}${lit}\n${closeIndent}${text.slice(m.close)}`
    }
    const sep = startsLine(text, prev.from)
      ? `,\n${leading(text, prev.from)}`
      : ", "
    return `${text.slice(0, prev.end)}${sep}${lit}${text.slice(prev.end)}`
  }
}

/** `a.b[0].c` or `a.b.0.c` -> ["a","b",0,"c"]. */
export const parsePath = (s: string): Path =>
  s
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p !== "")
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p))

export function getAt(root: unknown, path: Path): unknown {
  let cur = root
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return undefined
    cur = (cur as Record<string | number, unknown>)[seg]
  }
  return cur
}

/** A copy of `root` with `path` set, or removed when `value` is undefined. */
export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path as [string | number, ...Path]
  const copy: any = Array.isArray(root)
    ? [...root]
    : { ...(asObject(root) as object) }
  if (rest.length === 0 && value === undefined) {
    if (Array.isArray(copy)) copy.splice(head as number, 1)
    else delete copy[head]
  } else copy[head] = setAt(copy[head], rest, value)
  return copy
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export type ValidatedEdit =
  | { ok: true; backup?: string }
  | { ok: false; reason: string }

/**
 * Sets (or, with undefined, removes) one nested value, but only if the whole
 * file still builds into a config with no new warning. The previous file is
 * copied next to it first (`<file>.bak-<timestamp>`), and an invalid edit
 * leaves both the file and the backups alone.
 *
 * `effective` is the config as the plugin sees it. When the file lacks the
 * `v2.<section>` that the path is in (the section is all defaults), or lacks
 * an array the path needs, the whole section is written, computed from it.
 */
export function editValidated(
  path: Path,
  value: unknown,
  file: string = configPath(),
  effective?: unknown,
): ValidatedEdit {
  try {
    const before = readText(file)
    const warned = buildConfig(parseJsonc(before)).warnings
    // A section the file does not have yet is written whole, from the config
    // as the plugin sees it, so the file never holds a half-section.
    const section = path.slice(0, 2)
    const whole =
      effective !== undefined &&
      path.length > 2 &&
      getAt(parseJsonc(before), section) === undefined
    let after = whole ? null : setJsoncPath(before, path, value)
    let wrote: [Path, unknown] = [path, value]
    if (after === null && effective !== undefined && path.length > 2) {
      const next = setAt(getAt(effective, section), path.slice(2), value)
      after = setJsoncPath(before, section, next)
      wrote = [section, next]
    }
    if (after === null)
      return {
        ok: false,
        reason: `could not edit ${path.join(".")} safely; file left alone`,
      }
    const parsed = parseJsonc(after)
    if (!same(getAt(parsed, wrote[0]), wrote[1]))
      return {
        ok: false,
        reason: `edit of ${path.join(".")} did not apply; file left alone`,
      }
    const fresh = buildConfig(parsed).warnings.filter(
      (w) => !warned.includes(w),
    )
    if (fresh.length > 0) return { ok: false, reason: fresh.join("; ") }
    let backup: string | undefined
    if (existsSync(file)) {
      backup = `${file}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}`
      copyFileSync(file, backup)
    }
    writeAtomic(file, after)
    return { ok: true, ...(backup ? { backup } : {}) }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
