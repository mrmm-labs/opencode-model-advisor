import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  commandsMarkdown,
  forward,
  dispatch,
  fuzzy,
  helpLines,
  parse,
  slashEntries,
  slashUsage,
  SUBS,
  usageOf,
  type Deps,
  type Opt,
  type Sub,
  type Ui,
} from "./commands.ts"

const opts = (...values: string[]): Opt[] =>
  values.map((v) => ({ title: v, value: v, description: `desc ${v}` }))

function fakeDeps() {
  const calls: unknown[][] = []
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const deps: Deps = {
    agents: () => opts("builder", "approver"),
    tiers: () => opts("haiku", "sonnet", "opus"),
    pins: () => opts("builder"),
    decisions: () => opts("d1", "d2"),
    calibration: () => opts("report", "cutoff:high"),
    sections: () => opts("levels", "policy"),
    mode: () => "shadow",
    show: async (...a) => void calls.push(["show", ...a]),
    sessionLines: () => ["session line"],
    rulesLines: () => ["rules line"],
    alertLines: () => ["alert line"],
    usageLines: (w) => [`usage ${w}`],
    decisionDetail: (id) => `detail of ${id}\nsecond`,
    setMode: async (m) => void calls.push(["setMode", m]),
    pin: rec("pin"),
    unpin: rec("unpin"),
    check: async (t) => void calls.push(["check", t]),
    settings: async (s) => void calls.push(["settings", s]),
    calibrate: async (i) => void calls.push(["calibrate", i]),
    openAlert: rec("openAlert"),
  }
  return { deps, calls }
}

type Step = string | undefined | ((o: Opt[]) => string | undefined)

/** Scripted dialogs: each select/prompt takes the next answer; none left cancels. */
const answer = (queue: Step[], options?: Opt[]) => {
  const a = queue.shift()
  return typeof a === "function" ? a(options ?? []) : a
}

function fakeUi(selects: Step[] = [], prompts: Step[] = []) {
  const log: Array<{
    kind: string
    title: string
    options?: Opt[]
    [k: string]: unknown
  }> = []
  const toasts: string[] = []
  const ui: Ui = {
    select: async (o) => {
      log.push({ kind: "select", ...o })
      return answer(selects, o.options)
    },
    prompt: async (o) => {
      log.push({ kind: "prompt", ...o })
      return answer(prompts)
    },
    toast: (t) => void toasts.push(t.message),
  }
  return { ui, log, toasts }
}

const run = async (
  input: string,
  selects: Step[] = [],
  prompts: Step[] = [],
) => {
  const { deps, calls } = fakeDeps()
  const f = fakeUi(selects, prompts)
  await dispatch(input, SUBS, deps, f.ui)
  return { calls, ...f }
}

describe("parse", () => {
  const { deps } = fakeDeps()

  it("takes a full typed form, with quotes keeping spaces", () => {
    const p = parse("pin builder opus", SUBS, deps)
    assert.ok(p.type === "run")
    assert.equal(p.sub.name, "pin")
    assert.deepEqual(p.values, { target: "builder", tier: "opus" })
    assert.equal(p.invalid, undefined)
    const q = parse('pin "my agent" OPUS', SUBS, deps)
    assert.ok(q.type === "run")
    assert.deepEqual(q.values, { target: "my agent", tier: "opus" })
  })

  it("takes the rest of the line for a rest argument", () => {
    const p = parse("check [[route: task=1 risk=high]]", SUBS, deps)
    assert.ok(p.type === "run")
    assert.deepEqual(p.values, { input: "[[route: task=1 risk=high]]" })
    const q = parse('check "1047"', SUBS, deps)
    assert.ok(q.type === "run")
    assert.deepEqual(q.values, { input: "1047" })
  })

  it("runs a unique prefix and prefers an exact name", () => {
    const m = parse("mo enforce", SUBS, deps)
    assert.ok(m.type === "run" && m.sub.name === "mode")
    assert.deepEqual(m.values, { mode: "enforce" })
    const a = parse("alert", SUBS, deps)
    assert.ok(a.type === "run" && a.sub.name === "alert", "alert, not alerts")
  })

  it("offers the picker for nothing, an ambiguous prefix and an unknown word", () => {
    const none = parse("  ", SUBS, deps)
    assert.ok(none.type === "pick" && none.matches.length === SUBS.length)
    const amb = parse("ale", SUBS, deps)
    assert.ok(amb.type === "pick")
    assert.deepEqual(
      amb.matches.map((s) => s.name),
      ["alerts", "alert"],
    )
    const unknown = parse("frobnicate", SUBS, deps)
    assert.ok(unknown.type === "pick" && unknown.matches.length === 0)
  })

  it("reports the first invalid value and drops what follows it", () => {
    const p = parse("pin builder gold extra", SUBS, deps)
    assert.ok(p.type === "run" && p.invalid)
    assert.equal(p.invalid.arg.name, "tier")
    assert.deepEqual(p.invalid.valid, ["haiku", "sonnet", "opus"])
    assert.deepEqual(p.values, { target: "builder" })
  })

  it("flags extra words and a non-number", () => {
    const p = parse("rules now please", SUBS, deps)
    assert.ok(p.type === "run")
    assert.deepEqual(p.extra, ["now", "please"])
    const numeric: Sub = {
      name: "n",
      title: "n",
      description: "n",
      category: "c",
      args: [{ name: "count", kind: "number", placeholder: "n" }],
      usage: "/advisor n <count>",
      run: () => {},
    }
    const bad = parse("n lots", [numeric], deps)
    assert.ok(bad.type === "run" && bad.invalid?.arg.name === "count")
    const good = parse("n 3", [numeric], deps)
    assert.ok(good.type === "run" && good.values.count === "3")
  })
})

describe("dispatch", () => {
  it("runs the typed fast path without opening a dialog", async () => {
    const r = await run("pin builder opus")
    assert.deepEqual(r.calls, [["pin", "builder", "opus"]])
    assert.equal(r.log.length, 0)
  })

  it("opens the picker of every sub-command for nothing, with usage footers", async () => {
    const r = await run("", [undefined])
    const [pick] = r.log
    assert.equal(pick?.title, "Model router")
    assert.deepEqual(
      pick?.options?.map((o) => o.title),
      SUBS.map((s) => s.name),
    )
    const pin = pick?.options?.find((o) => o.title === "pin")
    assert.equal(pin?.footer, "/advisor pin <target> <tier>")
    assert.equal(pin?.category, "Change")
    assert.equal(r.calls.length, 0, "cancelled: nothing done")
  })

  it("walks the missing arguments of a picked sub-command", async () => {
    const r = await run("", ["pin", "approver", "sonnet"])
    assert.deepEqual(r.calls, [["pin", "approver", "sonnet"]])
    const [, target, tier] = r.log
    assert.equal(target?.title, "Model router: pin target")
    assert.deepEqual(target?.options?.map((o) => o.value).slice(0, 3), [
      "session",
      "builder",
      "approver",
    ])
    assert.equal(target?.options?.at(-1)?.title, "Type a name...")
    assert.deepEqual(
      tier?.options?.map((o) => o.value),
      ["haiku", "sonnet", "opus"],
    )
  })

  it("prompts only for what is missing, typing a name through 'Type a name...'", async () => {
    const r = await run("pin", [(o) => o.at(-1)?.value, "opus"], ["newagent"])
    assert.deepEqual(r.calls, [["pin", "newagent", "opus"]])
    const p = await run("pin builder", ["opus"])
    assert.deepEqual(p.calls, [["pin", "builder", "opus"]])
    assert.equal(p.log.length, 1, "only the tier was asked")
  })

  it("marks the current value in an enum picker", async () => {
    const r = await run("mode", [undefined])
    assert.equal(r.log[0]?.current, "shadow")
  })

  it("prompts free text with its placeholder, and treats empty as cancel", async () => {
    const r = await run("check", [], ["1047"])
    assert.deepEqual(r.calls, [["check", "1047"]])
    assert.match(String(r.log[0]?.placeholder), /task id/)
    assert.equal((await run("check", [], ["   "])).calls.length, 0)
    assert.equal((await run("check")).calls.length, 0)
  })

  it("cancels cleanly at any step", async () => {
    assert.equal((await run("pin", [undefined])).calls.length, 0)
    assert.equal((await run("pin", ["builder", undefined])).calls.length, 0)
    assert.equal((await run("", ["pin", "builder", undefined])).calls.length, 0)
  })

  it("tells the valid values and reopens that argument's picker", async () => {
    const r = await run("pin builder gold", ["opus"])
    assert.match(
      r.toasts[0] ?? "",
      /"gold" is not a tier\. Valid: haiku, sonnet, opus/,
    )
    assert.deepEqual(r.calls, [["pin", "builder", "opus"]])
    assert.equal(r.log[0]?.title, "Model router: pin tier")
  })

  it("opens the picker filtered to an ambiguous prefix, and warns on an unknown word", async () => {
    const amb = await run("ale", ["alerts"])
    assert.deepEqual(
      amb.log[0]?.options?.map((o) => o.value),
      ["alerts", "alert"],
    )
    assert.equal(amb.log[0]?.title, "Model router: /advisor ale...")
    assert.deepEqual(amb.calls, [
      ["show", "Model router: alerts", ["alert line"]],
    ])
    const unknown = await run("frob", [undefined])
    assert.match(unknown.toasts[0] ?? "", /No sub-command "frob"/)
    assert.equal(unknown.log[0]?.options?.length, SUBS.length)
  })

  it("says so when there is nothing to pick from", async () => {
    const { deps, calls } = fakeDeps()
    deps.pins = () => []
    const f = fakeUi()
    await dispatch("unpin", SUBS, deps, f.ui)
    assert.deepEqual(f.toasts, ["Nothing is pinned."])
    assert.equal(calls.length, 0)
    assert.equal(f.log.length, 0)
  })

  it("refuses extra words with the usage, and runs the no-argument ones", async () => {
    const r = await run("rules now")
    assert.match(
      r.toasts[0] ?? "",
      /Unexpected "now"\. Usage: \/advisor rules$/,
    )
    assert.equal(r.calls.length, 0)
    const ok = await run("session")
    assert.deepEqual(ok.calls, [
      ["show", "Model router: this session", ["session line"]],
    ])
  })

  it("shows a decision's detail after picking it", async () => {
    const r = await run("decisions", ["d2"])
    assert.deepEqual(r.calls, [
      ["show", "Decision", ["detail of d2", "second"]],
    ])
  })

  it("routes mode, settings, calibration, unpin and alert to their actions", async () => {
    assert.deepEqual((await run("mode enforce")).calls, [
      ["setMode", "enforce"],
    ])
    assert.deepEqual((await run("settings policy")).calls, [
      ["settings", "policy"],
    ])
    assert.deepEqual((await run("calibration report")).calls, [
      ["calibrate", "report"],
    ])
    assert.deepEqual((await run("unpin builder")).calls, [["unpin", "builder"]])
    assert.deepEqual((await run("alert")).calls, [["openAlert"]])
  })

  it("runs optional arguments with their default and never asks for them", async () => {
    const seen: unknown[] = []
    const opt: Sub = {
      name: "opt",
      title: "o",
      description: "o",
      category: "c",
      args: [
        {
          name: "n",
          kind: "number",
          placeholder: "n",
          optional: true,
          default: () => "20",
        },
      ],
      usage: usageOf("opt", [
        { name: "n", kind: "number", placeholder: "n", optional: true },
      ]),
      run: (v) => void seen.push(v),
    }
    const { deps } = fakeDeps()
    const f = fakeUi()
    await dispatch("opt", [opt], deps, f.ui)
    assert.deepEqual(seen, [{ n: "20" }])
    assert.equal(f.log.length, 0)
    assert.equal(opt.usage, "/advisor opt [n]")
  })

  it("re-asks a number until it parses", async () => {
    const seen: unknown[] = []
    const num: Sub = {
      name: "num",
      title: "n",
      description: "n",
      category: "c",
      args: [
        {
          name: "count",
          kind: "number",
          placeholder: "how many",
          default: () => "5",
        },
      ],
      usage: "/advisor num <count>",
      run: (v) => void seen.push(v),
    }
    const { deps } = fakeDeps()
    const f = fakeUi([], ["lots", "7"])
    await dispatch("num", [num], deps, f.ui)
    assert.deepEqual(seen, [{ count: "7" }])
    assert.equal(f.log[0]?.value, "5", "prefilled with the default")
    assert.match(f.toasts[0] ?? "", /"lots" is not a number/)
  })
})

describe("fuzzy", () => {
  const list = [
    { title: "pin", description: "Pin an agent" },
    { title: "settings", description: "Edit routing settings" },
    { title: "session", description: "Decisions of the session" },
    { title: "check", description: "Dry run" },
  ]
  it("ranks prefix, then substring, then letters in order, then description", () => {
    assert.deepEqual(
      fuzzy("se", list).map((o) => o.title),
      ["settings", "session"],
    )
    assert.deepEqual(
      fuzzy("ses", list).map((o) => o.title),
      ["session", "settings"],
    )
    assert.deepEqual(
      fuzzy("dry", list).map((o) => o.title),
      ["check"],
    )
    assert.equal(fuzzy("zzz", list).length, 0)
    assert.equal(fuzzy("  ", list).length, list.length)
  })
})

const norm = (t: string) =>
  t
    .split("\n")
    .filter((l) => l.trim())
    .map((l) =>
      l
        .split("|")
        .map((c) => c.trim().replace(/-{3,}/, "---"))
        .join("|"),
    )
    .join("\n")

describe("slash entries", () => {
  const entries = slashEntries(SUBS)

  it("has one per sub-command, in registry order, with unique names", () => {
    assert.deepEqual(
      entries.map((e) => e.sub),
      SUBS.map((s) => s.name),
    )
    assert.deepEqual(
      entries.map((e) => e.name),
      SUBS.map((s) => `advisor-${s.name}`),
    )
    assert.equal(new Set(entries.map((e) => e.name)).size, entries.length)
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
    assert.ok(entries.every((e) => e.name !== "advisor"))
  })

  it("takes its title and description, with the usage line, from the registry", () => {
    for (const [i, s] of SUBS.entries()) {
      assert.equal(entries[i]!.title, `advisor: ${s.name}`)
      assert.equal(
        entries[i]!.description,
        `${s.description} — ${slashUsage(s)}`,
      )
    }
    assert.equal(
      entries.find((e) => e.sub === "pin")?.description,
      "Pin an agent, or this session, to a tier — /advisor-pin <target> <tier>",
    )
    assert.equal(
      slashUsage(SUBS.find((s) => s.name === "check")!),
      "/advisor-check <input...>",
    )
  })

  it("forwards the rest of the line, so /advisor-pin builder opus is /advisor pin builder opus", async () => {
    assert.equal(forward("pin", "builder opus"), "pin builder opus")
    assert.equal(forward("pin", undefined), "pin")
    assert.equal(forward("rules", "  "), "rules")
    const { deps, calls } = fakeDeps()
    for (const [sub, rest] of [
      ["pin", "builder opus"],
      ["mode", "enforce"],
      ["check", "1047"],
    ] as const)
      await dispatch(forward(sub, rest), SUBS, deps, fakeUi().ui)
    assert.deepEqual(calls, [
      ["pin", "builder", "opus"],
      ["setMode", "enforce"],
      ["check", "1047"],
    ])
  })
})

describe("registry", () => {
  it("has unique names and a usage line derived from the arguments", () => {
    assert.equal(new Set(SUBS.map((s) => s.name)).size, SUBS.length)
    for (const s of SUBS) assert.equal(s.usage, usageOf(s.name, s.args))
    assert.equal(
      SUBS.find((s) => s.name === "check")?.usage,
      "/advisor check <input...>",
    )
  })

  it("covers every command the plugin used to register", () => {
    for (const old of [
      "alert",
      "decisions",
      "calibration",
      "settings",
      "pin",
      "mode",
      "check",
      "session",
      "rules",
      "alerts",
    ])
      assert.ok(
        SUBS.some((s) => s.name === old),
        old,
      )
  })

  it("generates the help table from the registry", async () => {
    const lines = helpLines(SUBS)
    assert.match(lines[0]!, /^ {2}\/advisor {2,}Open the picker$/)
    for (const s of SUBS)
      assert.ok(
        lines.some((l) => l.includes(s.usage) && l.includes(s.description)),
        s.name,
      )
    assert.ok(lines.includes("Look at:") && lines.includes("Change:"))
    const { deps, calls } = fakeDeps()
    await dispatch("help", SUBS, deps, fakeUi().ui)
    assert.deepEqual(calls, [["show", "Model router: commands", lines]])
  })

  it("usage shows today by default, and the window typed", async () => {
    const a = fakeDeps()
    await dispatch("usage", SUBS, a.deps, fakeUi().ui)
    assert.deepEqual(a.calls, [
      ["show", "Model router: usage", ["usage today"]],
    ])
    const b = fakeDeps()
    await dispatch("usage 7d", SUBS, b.deps, fakeUi().ui)
    assert.deepEqual(b.calls, [["show", "Model router: usage", ["usage 7d"]]])
    const entry = slashEntries(SUBS).find((e) => e.sub === "usage")
    assert.equal(entry?.name, "advisor-usage")
  })

  it("matches the README's Commands table", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    )
    const block = /<!-- commands:start -->([\s\S]*?)<!-- commands:end -->/.exec(
      readme,
    )?.[1]
    assert.ok(block, "README needs the commands markers")
    assert.equal(norm(block), norm(commandsMarkdown(SUBS)))
  })
})
