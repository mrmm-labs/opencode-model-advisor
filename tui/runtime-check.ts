// Runtime check of the TUI entry: run with `bun tui/runtime-check.ts` after a build.
// Type-checking cannot catch a member missing at runtime, so this drives the
// real entry with a fake OpenCode 2 context: registered slot and commands, the
// decisions list dialog, and a mode switch that edits a config file.
import assert from "node:assert/strict"
import {
  appendFileSync,
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
  '// keep me\n{\n  "mode": "shadow",\n  "rules": [{ "id": "r", "when": { "agent": "builder" }, "tier": "opus", "label": "touches auth / security" }],\n  "pins": {}\n}\n',
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
      summary: "Fix the login flow",
    },
    {
      v: 1,
      kind: "saving",
      t: new Date().toISOString(),
      session: "c",
      usd: 1.5,
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
const navigations: any[] = []
const notified: any[] = []
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
    router: {
      current: () => ({ type: "session", sessionID: "s1" }),
      navigate: (d: any) => navigations.push(d),
    },
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
  data: {
    session: {
      get: (id: string) =>
        id === "s1"
          ? {
              id,
              title: "Fix billing",
              location: { directory: "/work/acme-api" },
            }
          : undefined,
    },
  },
  client: {
    session: { get: async () => Promise.reject(new Error("unknown")) },
  },
  attention: {
    notify: async (o: any) => (notified.push(o), { ok: true }),
  },
}

const { default: plugin } = await import("./advisor-tui.tsx")
assert.equal(plugin.id, "model-advisor.tui")
assert.equal(typeof plugin.tui, "function")
const stop = plugin.setup(ctx as never)

assert.equal(slots.length, 1)
assert.equal(slots[0].append, "sidebar.content")
assert.equal(slots[0].prepend, undefined)

// The sidebar renders in a headless renderer. FRAMES=1 prints what it drew.
const { testRender } = await import("@opentui/solid")
const draw = async (slot: any, height = 6) => {
  const shown = await testRender(() => slot.render({ sessionID: "s1" }), {
    width: 38,
    height,
  })
  await shown.renderOnce()
  const frame = shown.captureCharFrame()
  shown.renderer.destroy()
  return frame
}
const compactFrame = await draw(slots[0])
assert.match(compactFrame, /^Model router · watching only\s*$/m)
assert.match(compactFrame, /^ {2}Last task {2}builder · opus 5\.5\s*$/m)
assert.match(compactFrame, /^ {2}Why {8}touches auth \/ security\s*$/m)
assert.match(compactFrame, /^ {2}Suggested {2}sonnet 5\.5 — cheaper\s*$/m)
assert.match(compactFrame, /^ {2}Today {6}would save ≈ \$1\.50\s*$/m)
assert.equal(compactFrame.split("\n").filter((l) => l.trim()).length, 5)

// "full" keeps the old per-decision block, "off" registers nothing.
const cfgFile = process.env.OPENCODE_MODEL_ADVISOR_CONFIG
const base = readFileSync(cfgFile, "utf8")
const mount = (sidebar: string) => {
  writeFileSync(
    cfgFile,
    base.replace('"pins"', `"tui": {"sidebar": "${sidebar}"}, "pins"`),
  )
  const claimed: any[] = []
  const stopOne = plugin.setup({
    ...ctx,
    ui: { ...ctx.ui, slot: (c: any) => claimed.push(c) },
    keymap: { layer: () => {} },
  } as never)
  return { claimed, stopOne }
}
const fullMount = mount("full")
const fullFrame = await draw(fullMount.claimed[0])
assert.match(fullFrame, /^▾ Model router · watching only\s*$/m)
assert.match(fullFrame, /^ {2}builder {2}opus 5\.5 → sonnet 5\.5\s*$/m)
assert.match(fullFrame, /^ {4}touches auth \/ security\s*$/m)
fullMount.stopOne()
const offMount = mount("off")
assert.equal(offMount.claimed.length, 0)
offMount.stopOne()
writeFileSync(cfgFile, base)
if (process.env.FRAMES) {
  console.log(`--- compact ---\n${compactFrame}\n--- full ---\n${fullFrame}`)
}

// The host completes only slash names, so bare /advisor is the picker and every
// sub-command has its own entry, which is also what the palette lists.
const commands = layers[0].commands
const subNames = [
  "session",
  "rules",
  "alerts",
  "decisions",
  "calibration",
  "mode",
  "pin",
  "unpin",
  "settings",
  "check",
  "alert",
  "help",
]
assert.deepEqual(
  commands.map((c: any) => c.slash.name),
  ["advisor", ...subNames.map((n) => `advisor-${n}`)],
)
assert.ok(commands.every((c: any) => c.slash.arguments === true))
assert.ok(commands.every((c: any) => c.palette === true))
assert.deepEqual(
  commands.slice(1).map((c: any) => c.id),
  subNames.map((n) => `model-advisor.${n}`),
)
assert.match(
  commands.find((c: any) => c.slash.name === "advisor-pin").description,
  /\/advisor-pin <target> <tier>$/,
)
const slashed = [commands[0]]
const bySlash = (name: string) =>
  commands.find((c: any) => c.slash.name === name)

// The V2 adapter does not return the command's promise: give it time to settle.
const run = async (input = "") => {
  slashed[0].run(input)
  await new Promise((r) => setTimeout(r, 60))
}

// /advisor is a searchable picker of every sub-command, with usage footers; the
// detail the sidebar leaves out is a sub-command each.
selectAnswers.push("session")
await run()
assert.equal(selects[0].title, "Model router")
assert.equal(selects[0].options.length, 12)
assert.equal(
  selects[0].options.find((o: any) => o.title === "pin").footer,
  "/advisor pin <target> <tier>",
)
assert.equal(typeof selects[0].search, "function")
if (process.env.FRAMES) {
  const o = selects[0].options as any[]
  const w = Math.max(...o.map((x) => x.title.length))
  let cat = ""
  const lines = [`${selects[0].title}   (${selects[0].placeholder})`]
  for (const x of o) {
    if (x.category !== cat) lines.push(`  ${(cat = x.category)}`)
    lines.push(`    ${x.title.padEnd(w)}  ${x.description}`)
  }
  console.log(
    `--- picker ---\n${lines.join("\n")}\nfooter of the highlighted: ${o[0].footer}`,
  )
}
assert.match(
  alerts[0].message,
  /^The router is watching only\n\nbuilder {2}opus 5\.5 → sonnet 5\.5\n {2}touches auth \/ security\n/,
)
await run("rules")
assert.match(
  alerts[1].message,
  /^The router is watching only\. With no rule or pin it uses /,
)
assert.match(
  alerts[1].message,
  /touches auth \/ security → opus 5\.5 {3}\(rule r, tier opus\)/,
)
await run("alerts")
assert.equal(alerts[2].message, "No alerts yet.")
await run("help")
assert.match(alerts[3].message, /\/advisor pin <target> <tier>/)
// a prefix with one match runs it; an unknown word narrows nothing and says so
await run("rul")
assert.equal(alerts.length, 5)
await run("nope")
assert.match(toasts.at(-1).message, /No sub-command "nope"/)
selects.length = 0
alerts.length = 0

// An alert written after start becomes a toast that says who, where, what and what
// the router did, and names the session the host should offer to open.
await run("alert")
assert.match(toasts.at(-1).message, /No alert since the TUI started/)
appendFileSync(
  process.env.OPENCODE_MODEL_ADVISOR_DECISIONS,
  JSON.stringify({
    v: 1,
    kind: "alert",
    t: new Date().toISOString(),
    alert: "second-failure",
    agent: "builder",
    session: "s1",
    task: "9",
    decision: "d1",
    detail: "risk medium, score 0 low; matrix medium×low → standard; retry 3",
  }) + "\n",
)
await new Promise((r) => setTimeout(r, 2400))
const toast = toasts.find((x) => /failed twice/.test(x.title ?? ""))
assert.deepEqual(toast, {
  title: "Model router · builder failed twice",
  message:
    "Fix billing · acme-api\nFix the login flow\nWould retry on sonnet 5.5",
  variant: "warning",
  sessionID: "s1",
})
assert.equal(notified[0].title, toast.title)
assert.deepEqual(notified[0].notification, { when: "blurred" })
await run("alert")
assert.deepEqual(navigations, [{ type: "session", sessionID: "s1" }])
if (process.env.FRAMES)
  console.log(`--- toast ---\n${toast.title}\n${toast.message}`)

selectAnswers.push("d1")
await run("decisions")
assert.equal(selects[0].title, "Model router: decisions decision")
assert.equal(selects[0].options[0].category, "Would change the model")
assert.equal(selects[0].options[0].value, "d1")
assert.match(
  alerts.at(-1).message,
  /^builder ran opus 5\.5; the router would pick sonnet 5\.5\nWhy: touches auth \/ security\nTask: Fix the login flow/,
)
assert.match(alerts.at(-1).message, /\nDetails:\nmodels: claude-opus-5-5/)

// A sub-command's own slash entry runs exactly like /advisor <sub> <rest>.
bySlash("advisor-rules").run("")
await new Promise((r) => setTimeout(r, 60))
assert.match(alerts.at(-1).message, /^The router is watching only\. /)
bySlash("advisor-mode").run("gold")
await new Promise((r) => setTimeout(r, 60))
assert.match(toasts.at(-1).message, /Valid: shadow, enforce/)

// mode: typed value is validated; enforce asks first; the file keeps its comment.
await run("mode gold")
assert.match(toasts.at(-1).message, /Valid: shadow, enforce/)
selectAnswers.push(undefined)
await run("mode")
assert.equal(selects.at(-1).current, "shadow")
confirmed = false
await run("mode enforce")
assert.match(
  readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8"),
  /"shadow"/,
)
confirmed = true
await run("mode enforce")
const text = readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8")
assert.match(text, /"mode": "enforce"/)
assert.ok(text.startsWith("// keep me"))
assert.equal(toasts.at(-1).variant, "success")
await run("mode shadow")

// pin and unpin: the typed form, then the picker chain, then Esc.
bySlash("advisor-pin").run("builder opus")
await new Promise((r) => setTimeout(r, 60))
assert.deepEqual(
  JSON.parse(
    readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8").replace(
      /^\/\/.*\n/,
      "",
    ),
  ).pins,
  { builder: "opus" },
)
selectAnswers.push("opus")
await run("pin session")
assert.match(toasts.at(-1).message, /this session pinned to opus/)
selectAnswers.push("builder")
await run("unpin")
assert.equal(selects.at(-1).options[0].description, "opus")
assert.match(toasts.at(-1).message, /builder unpinned/)
const pinned = readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8")
selectAnswers.push(undefined)
await run("pin")
assert.equal(
  readFileSync(process.env.OPENCODE_MODEL_ADVISOR_CONFIG, "utf8"),
  pinned,
)
selectAnswers.push("session")
await run("unpin")

// check: a prompt for the hint line, then the dry run in an alert.
promptAnswers.push("[[route: task=1 risk=high files=12]]")
await run("check")
assert.equal(prompts[0].title, "Model router: check input")
assert.match(prompts[0].placeholder, /task id/)
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
await run("settings")
assert.equal(selects.at(-3).title, "Model router: settings section")
assert.equal(selects.at(-2).title, "Settings: Policy")
let after = readFileSync(cfgPath, "utf8")
assert.match(after, /"retryStep": 2/)
assert.ok(after.startsWith("// keep me"))
assert.equal(backups().length, 1)
assert.equal(toasts.at(-1).variant, "success")
assert.match(toasts.at(-1).message, /Backup/)

selectAnswers.push(row("retry step"))
promptAnswers.push("lots")
await run("settings policy")
assert.equal(toasts.at(-1).variant, "error")
assert.equal(readFileSync(cfgPath, "utf8"), after)
assert.equal(backups().length, 1)

// privacy: the task summary switch is a setting like any other.
selectAnswers.push(row("task summary"), "false")
await run("settings privacy")
assert.equal(selects.at(-3).title, "Settings: Privacy")
assert.match(readFileSync(cfgPath, "utf8"), /"summary": false/)
selectAnswers.push(row("task summary"), "true")
await run("settings privacy")

// calibration: nothing yet, then a report, an info item and an applied suggestion.
await run("calibration")
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
await run("calibration")
assert.match(alerts.at(-1).message, /monotonic: NO/)
assert.match(alerts.at(-1).message, /\$?—/)
const before = readFileSync(cfgPath, "utf8")
selectAnswers.push("unused:fast")
await run("calibration")
assert.equal(alerts.at(-1).message, "never chosen")
assert.equal(readFileSync(cfgPath, "utf8"), before)
confirmed = false
selectAnswers.push("cutoff:high")
await run("calibration")
assert.equal(readFileSync(cfgPath, "utf8"), before)
confirmed = true
selectAnswers.push("cutoff:high")
await run("calibration")
after = readFileSync(cfgPath, "utf8")
assert.match(after, /"high": 3/)
assert.ok(after.startsWith("// keep me"))
assert.equal(backups().length, 4)
assert.ok(existsSync(cfgPath))

stop()
console.log("tui runtime check: ok")
