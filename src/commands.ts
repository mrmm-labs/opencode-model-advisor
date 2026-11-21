/**
 * The `/advisor` command: one slash entry and a registry of sub-commands.
 *
 * The host completes only a slash command's name, never what follows it, so
 * "autocomplete" here is a searchable picker chain: `/advisor` lists the
 * sub-commands, and each missing argument is then picked from its live values
 * or typed against a placeholder. The typed form (`/advisor pin builder opus`)
 * is the fast path through the same registry. No UI types in here: the TUI
 * supplies `Deps` (live values and actions) and `Ui` (dialogs).
 */

export type Opt = {
  title: string
  value: string
  description?: string
  footer?: string
  category?: string
}

export type Values = Record<string, string>

export type Arg = {
  name: string
  kind: "enum" | "text" | "number"
  /** Shown in the prompt, e.g. "agent name, e.g. builder". */
  placeholder: string
  /** The live values to pick from. An enum with options is validated against them. */
  options?: (d: Deps, given: Values) => Opt[]
  /** Said when `options` comes back empty. */
  empty?: string
  /** The option marked current in the picker. */
  current?: (d: Deps) => string | undefined
  /** Never asked: left out, or filled with the default. */
  optional?: boolean
  /** Prefills the prompt. */
  default?: (d: Deps) => string | undefined
  /** Takes the rest of the line, spaces included. Last argument only. */
  rest?: boolean
  /** Also accepts a value that is not an option; the picker offers to type one. */
  other?: boolean
}

export type Sub = {
  name: string
  title: string
  description: string
  category: string
  args: Arg[]
  /** `/advisor pin <target> <tier>`, derived from the arguments. */
  usage: string
  run: (values: Values, d: Deps) => Promise<void> | void
}

/** What the sub-commands read and do. The TUI implements it. */
export interface Deps {
  agents(): Opt[]
  tiers(): Opt[]
  pins(): Opt[]
  decisions(): Opt[]
  calibration(): Opt[]
  sections(): Opt[]
  mode(): string
  show(title: string, lines: string[]): Promise<void>
  sessionLines(): string[]
  rulesLines(): string[]
  alertLines(): string[]
  usageLines(window: string): string[]
  decisionDetail(id: string): string | undefined
  setMode(mode: string): Promise<void>
  pin(target: string, tier: string): void
  unpin(target: string): void
  check(text: string): Promise<void>
  settings(section: string): Promise<void>
  calibrate(item: string): Promise<void>
  openAlert(): void
}

export type Ui = {
  select(o: {
    title: string
    options: Opt[]
    current?: string
    placeholder?: string
    search?: (query: string, options: readonly Opt[]) => readonly Opt[]
  }): Promise<string | undefined>
  prompt(o: {
    title: string
    description?: string
    placeholder?: string
    value?: string
  }): Promise<string | undefined>
  toast(t: {
    variant: "info" | "warning" | "error"
    title: string
    message: string
  }): void
}

const argUsage = (a: Arg): string => {
  const name = a.rest ? `${a.name}...` : a.name
  return a.optional ? `[${name}]` : `<${name}>`
}

export const usageOf = (name: string, args: Arg[]): string =>
  ["/advisor", name, ...args.map(argUsage)].join(" ")

const sub = (s: Omit<Sub, "usage">): Sub => ({
  ...s,
  usage: usageOf(s.name, s.args),
})

const SESSION_TARGET: Opt = {
  title: "session",
  value: "session",
  description: "the session you are in",
}

export const SUBS: Sub[] = [
  sub({
    name: "session",
    title: "This session",
    description: "Decisions and advisor usage of the session you are in",
    category: "Look at",
    args: [],
    run: (_, d) => d.show("Model router: this session", d.sessionLines()),
  }),
  sub({
    name: "rules",
    title: "Rules",
    description: "Rules, pins and the default tier",
    category: "Look at",
    args: [],
    run: (_, d) => d.show("Model router: rules", d.rulesLines()),
  }),
  sub({
    name: "alerts",
    title: "Alerts",
    description: "Recent alerts, newest first",
    category: "Look at",
    args: [],
    run: (_, d) => d.show("Model router: alerts", d.alertLines()),
  }),
  sub({
    name: "usage",
    title: "Usage",
    description: "What each model cost, executor and advisor: today, 7d or 30d",
    category: "Look at",
    args: [
      {
        name: "window",
        kind: "enum",
        placeholder: "today, 7d or 30d",
        options: () =>
          ["today", "7d", "30d"].map((w) => ({ title: w, value: w })),
        optional: true,
        default: () => "today",
      },
    ],
    run: ({ window }, d) =>
      d.show("Model router: usage", d.usageLines(window ?? "today")),
  }),
  sub({
    name: "decisions",
    title: "Decisions",
    description: "The last 20 decisions; pick one for the full reason",
    category: "Look at",
    args: [
      {
        name: "decision",
        kind: "enum",
        placeholder: "pick a decision",
        options: (d) => d.decisions(),
        empty: "No decisions yet.",
      },
    ],
    run: async ({ decision }, d) => {
      const detail = d.decisionDetail(decision!)
      if (detail) await d.show("Decision", detail.split("\n"))
    },
  }),
  sub({
    name: "calibration",
    title: "Calibration",
    description: "The calibration report, and suggestions to apply",
    category: "Look at",
    args: [
      {
        name: "item",
        kind: "enum",
        placeholder: "report, or a suggestion to apply",
        options: (d) => d.calibration(),
        empty: "No calibration yet. Run the calibrate command first.",
      },
    ],
    run: ({ item }, d) => d.calibrate(item!),
  }),
  sub({
    name: "mode",
    title: "Mode",
    description:
      "Watching only (shadow) or choosing models (enforce); enforce asks first",
    category: "Change",
    args: [
      {
        name: "mode",
        kind: "enum",
        placeholder: "shadow or enforce",
        options: () => [
          {
            title: "shadow",
            value: "shadow",
            description: "watching only: records what it would pick",
          },
          {
            title: "enforce",
            value: "enforce",
            description: "choosing models: subagents run on its pick",
          },
        ],
        current: (d) => d.mode(),
      },
    ],
    run: ({ mode }, d) => d.setMode(mode!),
  }),
  sub({
    name: "pin",
    title: "Pin",
    description: "Pin an agent, or this session, to a tier",
    category: "Change",
    args: [
      {
        name: "target",
        kind: "enum",
        placeholder: "agent name, e.g. builder, or session",
        options: (d) => [SESSION_TARGET, ...d.agents()],
        other: true,
      },
      {
        name: "tier",
        kind: "enum",
        placeholder: "tier, e.g. opus",
        options: (d) => d.tiers(),
        empty: "No tiers configured.",
      },
    ],
    run: ({ target, tier }, d) => d.pin(target!, tier!),
  }),
  sub({
    name: "unpin",
    title: "Unpin",
    description: "Remove a pin",
    category: "Change",
    args: [
      {
        name: "target",
        kind: "enum",
        placeholder: "a pinned agent or session",
        options: (d) => d.pins(),
        empty: "Nothing is pinned.",
      },
    ],
    run: ({ target }, d) => d.unpin(target!),
  }),
  sub({
    name: "settings",
    title: "Settings",
    description: "Edit routing settings, one section at a time",
    category: "Change",
    args: [
      {
        name: "section",
        kind: "enum",
        placeholder: "settings section",
        options: (d) => d.sections(),
      },
    ],
    run: ({ section }, d) => d.settings(section!),
  }),
  sub({
    name: "check",
    title: "Check",
    description:
      "Dry run: what the router would decide for a hint line or a task id",
    category: "Other",
    args: [
      {
        name: "input",
        kind: "text",
        placeholder: "[[route: task=1047 risk=high files=12]] or a task id",
        rest: true,
      },
    ],
    run: ({ input }, d) => d.check(input!),
  }),
  sub({
    name: "alert",
    title: "Open last alert",
    description: "Go to the session the latest alert was about",
    category: "Other",
    args: [],
    run: (_, d) => d.openAlert(),
  }),
  sub({
    name: "help",
    title: "Help",
    description: "List every sub-command with its usage",
    category: "Other",
    args: [],
    run: (_, d) => d.show("Model router: commands", helpLines(SUBS)),
  }),
]

/** `/advisor pin <target> <tier>` as typed through its own slash entry: `/advisor-pin <target> <tier>`. */
export const slashUsage = (s: Sub): string =>
  s.usage.replace(/^\/advisor (\S+)/, "/advisor-$1")

export type SlashEntry = {
  id: string
  /** The slash name the host completes. */
  name: string
  title: string
  description: string
  /** The sub-command it runs. */
  sub: string
}

/**
 * One host slash entry per sub-command. The host completes only a slash
 * command's name, so `/advisor-pin` is how a sub-command shows up in its list.
 */
export const slashEntries = (subs: Sub[]): SlashEntry[] =>
  subs.map((s) => ({
    id: `model-advisor.${s.name}`,
    name: `advisor-${s.name}`,
    title: `advisor: ${s.name}`,
    description: `${s.description} — ${slashUsage(s)}`,
    sub: s.name,
  }))

/** What `dispatch` is given for a slash entry's `input`: the sub-command, then the rest the host passed. */
export const forward = (name: string, rest?: string): string =>
  `${name} ${rest ?? ""}`.trim()

const OPEN = "Open the picker"

/** Usage table for the help dialog, grouped like the picker. */
export function helpLines(subs: Sub[]): string[] {
  const width = Math.max(...subs.map((s) => s.usage.length), "/advisor".length)
  const row = (usage: string, text: string) =>
    `  ${usage.padEnd(width)}  ${text}`
  const categories = [...new Set(subs.map((s) => s.category))]
  const lines = [row("/advisor", OPEN)]
  for (const c of categories) {
    lines.push("", `${c}:`)
    for (const s of subs)
      if (s.category === c) lines.push(row(s.usage, s.description))
  }
  return lines
}

/** The README's Commands table. */
export const commandsMarkdown = (subs: Sub[]): string =>
  [
    "| Command | What it does |",
    "| --- | --- |",
    `| \`/advisor\` | ${OPEN} |`,
    ...subs.map((s) => `| \`${s.usage}\` | ${s.description} |`),
  ].join("\n")

/** What the picker shows for a sub-command. */
export const subOption = (s: Sub): Opt => ({
  title: s.name,
  value: s.name,
  description: s.description,
  footer: s.usage,
  category: s.category,
})

/** Options matching the query, best first: title prefix, title word, subsequence, description. */
export function fuzzy<T extends { title: string; description?: string }>(
  query: string,
  options: readonly T[],
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  const subsequence = (s: string) => {
    let i = 0
    for (const ch of s) if (ch === q[i]) i++
    return i === q.length
  }
  const score = (o: T) => {
    const t = o.title.toLowerCase()
    if (t.startsWith(q)) return 0
    if (t.includes(q)) return 1
    if (subsequence(t)) return 2
    if (o.description?.toLowerCase().includes(q)) return 3
    return -1
  }
  return options
    .map((o, i) => ({ o, i, s: score(o) }))
    .filter((x) => x.s >= 0)
    .toSorted((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.o)
}

type Token = { text: string; start: number }

function tokenize(input: string): Token[] {
  const out: Token[] = []
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    out.push({ text: m[1] ?? m[2] ?? m[3]!, start: m.index })
  return out
}

const unquote = (s: string): string =>
  /^(["']).*\1$/.test(s) && s.length >= 2 ? s.slice(1, -1) : s

export type Check = { ok: true; value: string } | { ok: false; valid: string[] }

/** The canonical value for what was typed, or the values that would have been accepted. */
export function checkArg(
  arg: Arg,
  raw: string,
  d: Deps,
  given: Values = {},
): Check {
  const value = raw.trim()
  if (arg.kind === "number")
    return value !== "" && Number.isFinite(Number(value))
      ? { ok: true, value }
      : { ok: false, valid: [] }
  if (arg.kind === "text")
    return value ? { ok: true, value } : { ok: false, valid: [] }
  const options = arg.options?.(d, given)
  if (!options || arg.other)
    return value ? { ok: true, value } : { ok: false, valid: [] }
  const hit = options.find((o) => o.value.toLowerCase() === value.toLowerCase())
  return hit
    ? { ok: true, value: hit.value }
    : { ok: false, valid: options.map((o) => o.value) }
}

export type Parsed =
  | { type: "pick"; query: string; matches: Sub[] }
  | {
      type: "run"
      sub: Sub
      values: Values
      invalid?: { arg: Arg; value: string; valid: string[] }
      extra: string[]
    }

/**
 * Splits what follows `/advisor`. Empty input, or a word that is not exactly one
 * sub-command's name or prefix, gives the picker (all of them, or the matches).
 * Arguments are positional; quotes keep spaces; the first bad one is reported
 * and the ones after it are dropped to be asked again.
 */
export function parse(input: string, subs: Sub[], d: Deps): Parsed {
  const tokens = tokenize(input)
  if (tokens.length === 0) return { type: "pick", query: "", matches: subs }
  const word = tokens[0]!.text.toLowerCase()
  const exact = subs.find((s) => s.name === word)
  const matches = exact ? [exact] : subs.filter((s) => s.name.startsWith(word))
  if (matches.length !== 1)
    return { type: "pick", query: tokens[0]!.text, matches }

  const found = matches[0]!
  const given = tokens.slice(1)
  const values: Values = {}
  let i = 0
  for (const arg of found.args) {
    if (i >= given.length) break
    const raw = arg.rest
      ? unquote(input.slice(given[i]!.start).trim())
      : given[i]!.text
    const checked = checkArg(arg, raw, d, values)
    if (!checked.ok)
      return {
        type: "run",
        sub: found,
        values,
        invalid: { arg, value: raw, valid: checked.valid },
        extra: [],
      }
    values[arg.name] = checked.value
    i = arg.rest ? given.length : i + 1
  }
  return {
    type: "run",
    sub: found,
    values,
    extra: given.slice(i).map((t) => t.text),
  }
}

const OTHER = "\u0000other"

async function ask(
  s: Sub,
  arg: Arg,
  d: Deps,
  ui: Ui,
  values: Values,
): Promise<string | undefined> {
  const title = `Model router: ${s.name} ${arg.name}`
  const options = arg.options?.(d, values)
  if (options) {
    if (options.length === 0 && !arg.other) {
      ui.toast({
        variant: "info",
        title: "Model router",
        message: arg.empty ?? `Nothing to choose for ${arg.name}.`,
      })
      return undefined
    }
    const picked = await ui.select({
      title,
      options: arg.other
        ? [
            ...options,
            {
              title: "Type a name...",
              value: OTHER,
              description: arg.placeholder,
              category: "Other",
            },
          ]
        : options,
      current: arg.current?.(d),
      placeholder: `Search ${arg.name}`,
      search: fuzzy,
    })
    if (picked !== OTHER) return picked
  }
  for (;;) {
    const typed = await ui.prompt({
      title,
      placeholder: arg.placeholder,
      value: arg.default?.(d),
    })
    if (typed === undefined || typed.trim() === "") return undefined
    const checked = checkArg(arg, typed, d, values)
    if (checked.ok) return checked.value
    ui.toast({
      variant: "warning",
      title: "Model router",
      message:
        arg.kind === "number"
          ? `${JSON.stringify(typed.trim())} is not a number.`
          : `Invalid ${arg.name}.`,
    })
  }
}

/**
 * Runs `/advisor <input>`: the picker for nothing or a prefix that is not
 * unique, else the sub-command with whatever arguments were typed, asking for
 * the rest. Cancelling any dialog stops with nothing done.
 */
export async function dispatch(
  input: string,
  subs: Sub[],
  d: Deps,
  ui: Ui,
): Promise<void> {
  const parsed = parse(input, subs, d)
  let chosen: Sub
  let values: Values = {}
  if (parsed.type === "pick") {
    if (parsed.query && parsed.matches.length === 0)
      ui.toast({
        variant: "warning",
        title: "Model router",
        message: `No sub-command "${parsed.query}". Pick one.`,
      })
    const name = await ui.select({
      title: parsed.query
        ? `Model router: /advisor ${parsed.query}...`
        : "Model router",
      options: (parsed.matches.length > 0 ? parsed.matches : subs).map(
        subOption,
      ),
      placeholder: "Search sub-commands",
      search: fuzzy,
    })
    const hit = subs.find((s) => s.name === name)
    if (!hit) return
    chosen = hit
  } else {
    if (parsed.extra.length > 0) {
      ui.toast({
        variant: "warning",
        title: "Model router",
        message: `Unexpected ${parsed.extra.map((e) => JSON.stringify(e)).join(" ")}. Usage: ${parsed.sub.usage}`,
      })
      return
    }
    if (parsed.invalid) {
      const { arg, value, valid } = parsed.invalid
      ui.toast({
        variant: "warning",
        title: "Model router",
        message:
          valid.length > 0
            ? `${JSON.stringify(value)} is not a ${arg.name}. Valid: ${valid.join(", ")}`
            : `${JSON.stringify(value)} is not a valid ${arg.name}. Usage: ${parsed.sub.usage}`,
      })
    }
    chosen = parsed.sub
    values = parsed.values
  }

  for (const arg of chosen.args) {
    if (values[arg.name] !== undefined) continue
    if (arg.optional) {
      const fallback = arg.default?.(d)
      if (fallback !== undefined) values[arg.name] = fallback
      continue
    }
    const value = await ask(chosen, arg, d, ui, values)
    if (value === undefined) return
    values[arg.name] = value
  }
  await chosen.run(values, d)
}
