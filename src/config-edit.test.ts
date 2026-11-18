import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { buildConfig } from "./config.ts"
import {
  editValidated,
  getAt,
  parsePath,
  readPins,
  setAt,
  setJsoncPath,
  setJsoncValue,
  setMode,
  setPin,
} from "./config-edit.ts"
import { parseJsonc } from "./jsonc.ts"

const FILE = `// header comment
{
  // shadow records, enforce routes
  "mode": "shadow", // trailing note
  "tiers": { "haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5" },

  // pins beat everything
  "pins": {},

  /* rules stay */
  "rules": [
    { "id": "a", "when": { "agent": "x" }, "tier": "opus" },
  ],
}
`

function fixture(text = FILE) {
  const dir = mkdtempSync(join(tmpdir(), "advisor-edit-"))
  const path = join(dir, "model-advisor.jsonc")
  writeFileSync(path, text)
  return { dir, path, read: () => readFileSync(path, "utf8") }
}

describe("config edit", () => {
  it("switches the mode and keeps every comment", () => {
    const f = fixture()
    assert.deepEqual(setMode("enforce", f.path), { ok: true })
    const text = f.read()
    assert.match(text, /"mode": "enforce", \/\/ trailing note/)
    for (const note of [
      "header comment",
      "shadow records",
      "pins beat",
      "rules stay",
    ])
      assert.ok(text.includes(note), note)
    assert.equal(buildConfig(parseJsonc(text)).config.mode, "enforce")
  })

  it("pins and unpins, leaving the rest of the file alone", () => {
    const f = fixture()
    setPin("builder", "haiku", f.path)
    setPin("session:ses_1", "opus", f.path)
    assert.deepEqual(readPins(f.path), {
      builder: "haiku",
      "session:ses_1": "opus",
    })
    let text = f.read()
    assert.ok(text.includes("// pins beat everything"))
    assert.ok(text.includes("/* rules stay */"))
    assert.equal(buildConfig(parseJsonc(text)).config.rules.length, 1)
    assert.equal(buildConfig(parseJsonc(text)).config.pins.builder, "haiku")

    setPin("builder", undefined, f.path)
    assert.deepEqual(readPins(f.path), { "session:ses_1": "opus" })
    text = f.read()
    assert.ok(text.includes("// pins beat everything"))
    assert.equal(buildConfig(parseJsonc(text)).config.rules.length, 1)
  })

  it("changes an existing pin instead of adding a second", () => {
    const f = fixture()
    setPin("builder", "haiku", f.path)
    setPin("builder", "opus", f.path)
    assert.deepEqual(readPins(f.path), { builder: "opus" })
  })

  it("adds the key when the file lacks it, and creates a missing file", () => {
    const f = fixture('{\n  "mode": "shadow"\n}\n')
    setPin("builder", "haiku", f.path)
    assert.deepEqual(readPins(f.path), { builder: "haiku" })
    const dir = mkdtempSync(join(tmpdir(), "advisor-edit-"))
    const fresh = join(dir, "sub", "model-advisor.jsonc")
    assert.deepEqual(setMode("enforce", fresh), { ok: true })
    assert.equal(
      buildConfig(parseJsonc(readFileSync(fresh, "utf8"))).config.mode,
      "enforce",
    )
  })

  it("is atomic: a temp file is renamed over the target and none is left", () => {
    const f = fixture()
    setMode("enforce", f.path)
    setPin("builder", "haiku", f.path)
    assert.deepEqual(readdirSync(f.dir), ["model-advisor.jsonc"])
  })

  it("leaves the file alone when it cannot edit safely", () => {
    const f = fixture("[1, 2]")
    const result = setMode("enforce", f.path)
    assert.equal(result.ok, false)
    assert.equal(f.read(), "[1, 2]")
  })

  it("ignores a key that only appears in a comment or a string", () => {
    const text =
      '{\n  // "mode": "enforce"\n  "note": "\\"mode\\": 1", "mode": "shadow"\n}'
    const out = setJsoncValue(text, "mode", '"enforce"')
    assert.ok(out?.includes('// "mode": "enforce"'))
    assert.equal(
      (parseJsonc(out as string) as { mode: string }).mode,
      "enforce",
    )
  })
})

const V2 = `{
  // mode note
  "mode": "shadow",
  "v2": {
    // the levels
    "levels": { "fast": { "model": "a/b" }, "frontier": { "model": "c/d" } },
    "difficulty": {
      "points": [
        { "fact": "files", "gte": 15, "add": 2 }, // first
        { "fact": "modules", "gte": 3, "add": 2 },
      ],
      "cutoffs": { "medium": 2, "high": 4 },
    },
  },
}
`

describe("nested path edit", () => {
  const read = (t: string | null) => parseJsonc(t as string) as any

  it("sets a nested value and keeps comments", () => {
    const out = setJsoncPath(V2, ["v2", "difficulty", "cutoffs", "high"], 5)
    assert.equal(read(out).v2.difficulty.cutoffs.high, 5)
    assert.ok(out?.includes("// the levels"))
    assert.ok(out?.includes("// first"))
    assert.ok(out?.includes("// mode note"))
  })

  it("replaces an array element by index and appends at the end", () => {
    let out = setJsoncPath(V2, ["v2", "difficulty", "points", 1], {
      fact: "files",
      gte: 1,
      add: 1,
    })
    assert.deepEqual(read(out).v2.difficulty.points[1], {
      fact: "files",
      gte: 1,
      add: 1,
    })
    out = setJsoncPath(V2, ["v2", "difficulty", "points", 2], { fact: "x" })
    assert.equal(read(out).v2.difficulty.points.length, 3)
    assert.equal(read(out).v2.difficulty.points[2].fact, "x")
    assert.ok(out?.includes("// first"))
    assert.equal(
      setJsoncPath(V2, ["v2", "difficulty", "points", 5], { fact: "x" }),
      null,
    )
  })

  it("deletes an element and a key, even the last one", () => {
    let out = setJsoncPath(V2, ["v2", "difficulty", "points", 0], undefined)
    assert.deepEqual(
      read(out).v2.difficulty.points.map((p: any) => p.fact),
      ["modules"],
    )
    out = setJsoncPath(
      out as string,
      ["v2", "difficulty", "points", 0],
      undefined,
    )
    assert.deepEqual(read(out).v2.difficulty.points, [])
    out = setJsoncPath(V2, ["v2", "levels", "frontier"], undefined)
    assert.deepEqual(Object.keys(read(out).v2.levels), ["fast"])
    out = setJsoncPath(V2, ["v2", "levels", "fast"], undefined)
    assert.deepEqual(Object.keys(read(out).v2.levels), ["frontier"])
    assert.equal(setJsoncPath(V2, ["v2", "nope"], undefined), V2)
  })

  it("creates missing parent objects, not missing arrays", () => {
    const out = setJsoncPath(
      '{\n  "mode": "shadow"\n}\n',
      ["v2", "policy", "retryStep"],
      2,
    )
    assert.equal(read(out).v2.policy.retryStep, 2)
    assert.equal(read(out).mode, "shadow")
    assert.equal(
      setJsoncPath('{"v2": {}}', ["v2", "difficulty", "points", 0], 1),
      null,
    )
    assert.equal(
      read(setJsoncPath("{}", ["v2", "enabled"], true)).v2.enabled,
      true,
    )
    assert.equal(
      read(setJsoncPath('{"v2": {}}', ["v2", "enabled"], true)).v2.enabled,
      true,
    )
  })

  it("ignores a key that only appears in a comment or a string", () => {
    const text =
      '{\n  // "v2": { "x": 1 }\n  "note": "\\"v2\\"", "v2": { "x": 0 }\n}'
    const out = setJsoncPath(text, ["v2", "x"], 7)
    assert.equal(read(out).v2.x, 7)
    assert.ok(out?.includes('// "v2": { "x": 1 }'))
  })

  it("returns null for malformed text or a wrong parent", () => {
    assert.equal(setJsoncPath("[1", ["a"], 1), null)
    assert.equal(setJsoncPath('{"a": 1}', ["a", "b"], 1), null)
    assert.equal(setJsoncPath('{"a": [1]}', ["a", "x"], 1), null)
    assert.equal(setJsoncPath("{}", [], 1), null)
  })

  it("parses and walks paths", () => {
    assert.deepEqual(parsePath("v2.difficulty.points[1].add"), [
      "v2",
      "difficulty",
      "points",
      1,
      "add",
    ])
    assert.deepEqual(parsePath("a.0.b"), ["a", 0, "b"])
    assert.equal(getAt({ a: [{ b: 3 }] }, ["a", 0, "b"]), 3)
    assert.equal(getAt({ a: 1 }, ["a", "b"]), undefined)
    const src = { a: [1, 2, 3], b: { c: 1 } }
    assert.deepEqual(setAt(src, ["a", 1], 9), { a: [1, 9, 3], b: { c: 1 } })
    assert.deepEqual(setAt(src, ["a", 0], undefined), {
      a: [2, 3],
      b: { c: 1 },
    })
    assert.deepEqual(setAt(src, ["b", "c"], undefined), { a: [1, 2, 3], b: {} })
    assert.deepEqual(src, { a: [1, 2, 3], b: { c: 1 } })
  })
})

describe("validated edit", () => {
  const backups = (f: { dir: string }) =>
    readdirSync(f.dir).filter((n) => n.includes(".bak-"))

  it("backs up the file, then writes", () => {
    const f = fixture(V2)
    const r = editValidated(["v2", "difficulty", "cutoffs", "high"], 6, f.path)
    assert.equal(r.ok, true)
    assert.equal(backups(f).length, 1)
    assert.equal(readFileSync(join(f.dir, backups(f)[0]!), "utf8"), V2)
    assert.equal(
      getAt(parseJsonc(f.read()), ["v2", "difficulty", "cutoffs", "high"]),
      6,
    )
    assert.ok(f.read().includes("// the levels"))
  })

  it("refuses an invalid config and leaves the file and the folder alone", () => {
    const f = fixture(V2)
    const r = editValidated(["mode"], "bogus", f.path)
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /mode must be/)
    assert.equal(f.read(), V2)
    assert.equal(backups(f).length, 0)
  })

  it("does not blame an edit for a warning the file already had", () => {
    const f = fixture('{"mode": "bogus", "tui": {}}')
    const r = editValidated(["tui", "position"], "bottom", f.path)
    assert.equal(r.ok, true)
  })

  it("refuses text it cannot parse", () => {
    const f = fixture("{ nope")
    const r = editValidated(["mode"], "enforce", f.path)
    assert.equal(r.ok, false)
    assert.equal(f.read(), "{ nope")
  })

  it("falls back to the whole section when the file lacks the array", () => {
    const f = fixture('{\n  "mode": "shadow"\n}\n')
    const effective = {
      v2: {
        difficulty: {
          points: [{ fact: "files", add: 1 }],
          cutoffs: { medium: 2, high: 4 },
        },
      },
    }
    const r = editValidated(
      ["v2", "difficulty", "points", 0, "add"],
      3,
      f.path,
      effective,
    )
    assert.equal(r.ok, true)
    const out = parseJsonc(f.read()) as any
    assert.equal(out.v2.difficulty.points[0].add, 3)
    assert.equal(out.v2.difficulty.cutoffs.high, 4)
    assert.equal(out.mode, "shadow")
    assert.equal(
      editValidated(["v2", "difficulty", "points", 0, "add"], 3, f.path).ok,
      true,
    )
  })

  it("writes the whole section when the file lacks it, so none is half there", () => {
    const f = fixture('{\n  "mode": "shadow"\n}\n')
    const effective = {
      v2: { difficulty: { points: [], cutoffs: { medium: 2, high: 4 } } },
    }
    const r = editValidated(
      ["v2", "difficulty", "cutoffs", "high"],
      6,
      f.path,
      effective,
    )
    assert.equal(r.ok, true)
    const out = parseJsonc(f.read()) as any
    assert.deepEqual(out.v2.difficulty, {
      points: [],
      cutoffs: { medium: 2, high: 6 },
    })
  })

  it("creates a missing file without a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-edit-"))
    const path = join(dir, "x.jsonc")
    assert.deepEqual(editValidated(["mode"], "enforce", path), { ok: true })
    assert.equal(readdirSync(dir).length, 1)
  })
})
