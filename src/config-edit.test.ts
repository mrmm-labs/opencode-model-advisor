import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { buildConfig } from "./config.ts"
import { readPins, setJsoncValue, setMode, setPin } from "./config-edit.ts"
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
