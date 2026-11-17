// Runtime check of the TUI entry: run with `bun tui/runtime-check.ts` after a build.
// Type-checking cannot catch a member missing at runtime, so this drives the
// real entry with a fake OpenCode 2 context: registered slot and commands, the
// decisions list dialog, and a mode switch that edits a config file.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "advisor-tui-"))
process.env.OPENCODE_MODEL_ADVISOR_CONFIG = join(dir, "model-advisor.jsonc")
process.env.OPENCODE_MODEL_ADVISOR_DECISIONS = join(dir, "decisions.jsonl")
writeFileSync(
  process.env.OPENCODE_MODEL_ADVISOR_CONFIG,
  '// keep me\n{\n  "mode": "shadow",\n  "pins": {}\n}\n',
)
writeFileSync(
  process.env.OPENCODE_MODEL_ADVISOR_DECISIONS,
  [
    {
      v: 1,
      kind: "decision",
      t: new Date().toISOString(),
      id: "d1",
      session: "s1",
      agent: "builder",
      mode: "shadow",
      model: "claude-opus-5-5",
      would: "claude-sonnet-5-5",
      tier: "sonnet",
      source: "rule",
      rule: "r",
      reason: "rule r",
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
)

const slots: any[] = []
const layers: any[] = []
const toasts: any[] = []
const selects: any[] = []
let confirmed = true
const ctx = {
  options: {},
  theme: { text: { muted: { base: "#888" } } },
  ui: {
    slot: (claim: any) => slots.push(claim),
    toast: { show: (t: any) => toasts.push(t) },
    router: { current: () => ({ type: "session", sessionID: "s1" }) },
    dialog: {
      select: async (o: any) => (selects.push(o), undefined),
      confirm: async () => confirmed,
    },
  },
  keymap: { layer: (f: () => any) => layers.push(f()) },
}

const { default: plugin } = await import("./advisor-tui.tsx")
assert.equal(plugin.id, "model-advisor.tui")
assert.equal(typeof plugin.tui, "function")
const stop = plugin.setup(ctx as never)

assert.equal(slots.length, 1)
assert.equal(slots[0].prepend, "sidebar.content")

// The sidebar renders the router panel for the session, in a headless renderer.
const { testRender } = await import("@opentui/solid")
const shown = await testRender(() => slots[0].render({ sessionID: "s1" }), {
  width: 40,
  height: 6,
})
await shown.renderOnce()
const frame = shown.captureCharFrame()
assert.match(frame, /Model router shadow/)
assert.match(frame, /^  builder  opus → sonnet\s*$/m)
assert.match(frame, /^    r\s*$/m)
shown.renderer.destroy()

const commands = layers[0].commands
assert.deepEqual(
  commands.map((c: any) => c.slash.name),
  ["advisor-mode", "advisor-pin", "advisor-decisions"],
)
assert.ok(commands.every((c: any) => c.palette === true))

const run = (slash: string) =>
  commands.find((c: any) => c.slash.name === slash).run()
await run("advisor-decisions")
assert.equal(selects[0].title, "Model router: last 20 decisions")
assert.equal(selects[0].options[0].category, "Would change the model")
assert.equal(selects[0].options[0].value, "d1")

confirmed = false
await run("advisor-mode")
assert.match(
  readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8"),
  /"shadow"/,
)
confirmed = true
await run("advisor-mode")
await new Promise((r) => setTimeout(r, 50))
const text = readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8")
assert.match(text, /"mode": "enforce"/)
assert.ok(text.startsWith("// keep me"))
assert.equal(toasts.at(-1).variant, "success")

stop()
console.log("tui runtime check: ok")
