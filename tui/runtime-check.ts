// Runtime check of the TUI entry: run with `bun tui/runtime-check.ts` after a build.
// Type-checking cannot catch a member missing at runtime, so this drives the
// real entry with a fake OpenCode 2 context: registered slot and commands, the
// decisions list dialog, and a mode switch that edits a config file.
import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "advisor-tui-"))
process.env.OPENCODE_MODEL_ADVISOR_CONFIG = join(dir, "model-advisor.jsonc")
process.env.OPENCODE_MODEL_ADVISOR_DECISIONS = join(dir, "decisions.jsonl")
process.env.OPENCODE_MODEL_ADVISOR_CALIBRATION = join(dir, "calibration.json")
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
const alerts: any[] = []
const prompts: any[] = []
// Scripted answers: a value, or a function of the dialog options; none left means cancel.
const selectAnswers: any[] = []
const promptAnswers: any[] = []
let confirmed = true
const ctx = {
  options: {},
  theme: { text: { muted: { base: "#888" } } },
  ui: {
    slot: (claim: any) => slots.push(claim),
    toast: { show: (t: any) => toasts.push(t) },
    router: { current: () => ({ type: "session", sessionID: "s1" }) },
    dialog: {
      select: async (o: any) => {
        selects.push(o)
        const a = selectAnswers.shift()
        return typeof a === "function" ? a(o.options) : a
      },
      confirm: async () => confirmed,
      alert: async (o: any) => void alerts.push(o),
      prompt: async (o: any) => (prompts.push(o), promptAnswers.shift()),
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
  [
    "advisor-mode",
    "advisor-pin",
    "advisor-decisions",
    "advisor-check",
    "advisor-settings",
    "advisor-calibration",
  ],
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

// The V2 adapter does not return the command's promise: give it time to settle.
const runSettled = async (slash: string) => {
  run(slash)
  await new Promise((r) => setTimeout(r, 40))
}

// check: a prompt for the hint line, then the dry run in an alert.
promptAnswers.push("[[route: task=1 risk=high files=12]]")
await runSettled("advisor-check")
assert.equal(prompts[0].title, "Model router: check")
assert.match(alerts.at(-1).message, /dry run, nothing dispatched/)
assert.match(alerts.at(-1).message, /connectors: not configured/)

// settings: pick a section, then a row, type a value; the file keeps its comment,
// a backup appears, and an invalid value is refused with the file untouched.
const cfgPath = process.env.OPENCODE_MODEL_ADVISOR_CONFIG
const row = (title: string) => (opts: any[]) =>
  opts.find((o) => o.title === title).value
const backups = () => readdirSync(dir).filter((n) => n.includes(".bak-"))
selectAnswers.push("policy", row("retry step"))
promptAnswers.push("2")
await runSettled("advisor-settings")
assert.equal(selects.at(-3).title, "Model router: settings")
assert.equal(selects.at(-2).title, "Settings: Policy")
let after = readFileSync(cfgPath, "utf8")
assert.match(after, /"retryStep": 2/)
assert.ok(after.startsWith("// keep me"))
assert.equal(backups().length, 1)
assert.equal(toasts.at(-1).variant, "success")
assert.match(toasts.at(-1).message, /Backup/)

selectAnswers.push("policy", row("retry step"))
promptAnswers.push("lots")
await runSettled("advisor-settings")
assert.equal(toasts.at(-1).variant, "error")
assert.equal(readFileSync(cfgPath, "utf8"), after)
assert.equal(backups().length, 1)

// calibration: nothing yet, then a report, an info item and an applied suggestion.
await runSettled("advisor-calibration")
assert.match(toasts.at(-1).message, /No calibration yet/)
writeFileSync(
  process.env.OPENCODE_MODEL_ADVISOR_CALIBRATION,
  JSON.stringify({
    v: 1,
    t: new Date().toISOString(),
    window_days: 30,
    tasks: 9,
    buckets: [
      {
        risk: "low",
        difficulty: "low",
        level: "fast",
        tasks: 9,
        firstPass: 0.9,
        avgRetries: 0.1,
        costPerTask: null,
      },
    ],
    backtest: { monotonic: false, byDifficulty: {} },
    suggestions: [
      {
        id: "cutoff:high",
        kind: "cutoff",
        path: "v2.difficulty.cutoffs.high",
        from: 4,
        to: 3,
        why: "w",
      },
      {
        id: "unused:fast",
        kind: "info",
        path: "v2.levels.fast",
        from: "fast",
        to: "fast",
        why: "never chosen",
      },
    ],
  }),
)
selectAnswers.push("report")
await runSettled("advisor-calibration")
assert.match(alerts.at(-1).message, /monotonic: NO/)
assert.match(alerts.at(-1).message, /\$?—/)
const before = readFileSync(cfgPath, "utf8")
selectAnswers.push("unused:fast")
await runSettled("advisor-calibration")
assert.equal(alerts.at(-1).message, "never chosen")
assert.equal(readFileSync(cfgPath, "utf8"), before)
confirmed = false
selectAnswers.push("cutoff:high")
await runSettled("advisor-calibration")
assert.equal(readFileSync(cfgPath, "utf8"), before)
confirmed = true
selectAnswers.push("cutoff:high")
await runSettled("advisor-calibration")
after = readFileSync(cfgPath, "utf8")
assert.match(after, /"high": 3/)
assert.ok(after.startsWith("// keep me"))
assert.equal(backups().length, 2)
assert.ok(existsSync(cfgPath))

stop()
console.log("tui runtime check: ok")
