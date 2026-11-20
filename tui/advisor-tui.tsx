/** @jsxImportSource @opentui/solid */
/**
 * The router's TUI: a compact sidebar section per session, a detail dialog, commands and alert toasts.
 *
 * It runs in a different process from the server plugin, so it never touches
 * the router. It reads the decisions file the plugin appends to, and changes
 * behaviour only by editing the config file, which the plugin re-reads.
 *
 * One default export serves both plugin generations: V1 calls `tui`, V2 calls
 * `setup`. Both build a `Host` and share `start`.
 */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { createSignal, For, Show } from "solid-js"

import { buildConfig, configPath, defaultConfig } from "../dist/config.js"
import {
  editValidated,
  readPins,
  setMode,
  setPin,
  type Path,
} from "../dist/config-edit.js"
import {
  RecordReader,
  type AdvisorRecord,
  type AlertRecord,
} from "../dist/decisions.js"
import {
  dispatch,
  forward,
  slashEntries,
  SUBS,
  type Deps,
  type Ui,
} from "../dist/commands.js"
import { createConnectors } from "../dist/connectors.js"
import { explain } from "../dist/explain.js"
import { hintFacts, parseMarkers } from "../dist/hint.js"
import { parseJsonc } from "../dist/jsonc.js"
import {
  alertContextOf,
  alertLines,
  alertNotice,
  alertToast,
  AlertWatcher,
  calibrationFile,
  calibrationReport,
  checkDecision,
  compactPanel,
  decisionDetail,
  decisionRows,
  modeText,
  parseCalibration,
  parseHintFacts,
  parseSettingValue,
  routerPanel,
  ruleLabels,
  rulesLines,
  SECTIONS,
  sessionLines,
  settingRows,
  suggestionEdit,
  suggestionOptions,
  suggestionTitle,
  type CompactPanel,
  type Panel,
  type SettingRow,
  type Tone,
} from "../dist/view.js"

type Option<T> = {
  title: string
  value: T
  description?: string
  footer?: string
  category?: string
}
type Toast = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  /** Where the host offers to open, when it is not already open. */
  sessionID?: string
}
type Command = {
  id: string
  title: string
  description?: string
  slash: string
  run: (input?: string) => void
}

type Colours = {
  text: unknown
  muted: unknown
  changed: unknown
  good: unknown
}
type Position = "top" | "bottom"

type Host = {
  colours: () => Colours
  currentSession: () => string | undefined
  sidebar: (
    position: Position,
    render: (session: string) => JSX.Element,
  ) => void
  commands: (list: Command[]) => void
  select: <T>(
    title: string,
    options: Option<T>[],
    extra?: {
      current?: T
      placeholder?: string
      search?: (query: string, options: readonly any[]) => readonly any[]
    },
  ) => Promise<T | undefined>
  confirm: (title: string, message: string) => Promise<boolean>
  alert: (title: string, message: string) => Promise<void>
  prompt: (
    title: string,
    options?: { placeholder?: string; value?: string; description?: string },
  ) => Promise<string | undefined>
  toast: (toast: Toast) => void
  session: (
    id: string,
  ) => Promise<{ title?: string; directory?: string } | undefined>
  open: (sessionID: string) => void
  /** A system notification when the terminal is not in focus. */
  attention: (title: string, message: string) => void
}

const loadConfig = () => {
  try {
    return buildConfig(parseJsonc(readFileSync(configPath(), "utf8"))).config
  } catch {
    return defaultConfig()
  }
}

function start(host: Host): () => void {
  const reader = new RecordReader()
  let lastAlert: string | undefined

  const announce = async (alert: AlertRecord, all: AdvisorRecord[]) => {
    try {
      const cfg = loadConfig()
      const info = alert.session ? await host.session(alert.session) : undefined
      const notice = alertNotice(alert, all, {
        ...alertContextOf(cfg),
        session: info,
      })
      lastAlert = notice.sessionID
      host.toast(notice)
      host.attention(notice.title, notice.message)
    } catch {
      host.toast(alertToast(alert))
    }
  }
  const watcher = new AlertWatcher()
  const [records, setRecords] = createSignal(reader.read())
  watcher.fresh(reader.read())
  let lastSession: string | undefined

  // The reader hands back the same array while the file is unchanged, so the
  // signal only fires on a write.
  const timer = setInterval(() => {
    const all = reader.read()
    setRecords(all)
    for (const alert of watcher.fresh(all)) void announce(alert, all)
  }, 2000)

  // Folding lasts for this TUI run; a click on the heading toggles it.
  const [folded, setFolded] = createSignal(false)
  const { sidebar, position } = loadConfig().tui

  const compact = (session: string) => {
    lastSession = session
    const panel = () =>
      compactPanel(records(), session, {
        labels: ruleLabels(loadConfig()),
      }) as CompactPanel
    const c = () => host.colours() as Record<keyof Colours, never>
    const tone = (t: Tone | undefined) =>
      t === "good" ? c().good : t === "changed" ? c().changed : c().text
    return (
      <Show when={panel()}>
        <box
          paddingTop={position === "bottom" ? 1 : 0}
          paddingBottom={position === "top" ? 1 : 0}
        >
          <text fg={c().text} onMouseUp={() => openPicker(session)}>
            <b>Model router</b>
            <span
              style={{ fg: c().muted }}
            >{` \u00b7 ${modeText(panel().mode)}`}</span>
          </text>
          <For each={panel().rows}>
            {(row) => (
              <text fg={c().text}>
                <span style={{ fg: c().muted }}>{`  ${row.label}`}</span>
                <span style={{ fg: tone(row.tone) }}>{row.value}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    )
  }

  const full = (session: string) => {
    lastSession = session
    const panel = () =>
      routerPanel(records(), session, 4, ruleLabels(loadConfig()))
    const p = () => panel() as Panel
    const c = () => host.colours() as Record<keyof Colours, never>
    // Lists, not nested <Show>: a false <Show> inside a <box> leaves an
    // orphan text node, which opentui rejects.
    const footer = () =>
      [
        p().more > 0 && `  +${p().more} more · /advisor decisions`,
        p().advice && `  ${p().advice}`,
      ].filter((l): l is string => !!l)
    const agentWidth = () =>
      Math.min(
        14,
        Math.max(5, ...(panel()?.rows ?? []).map((r) => r.agent.length)),
      )
    return (
      <Show when={panel()}>
        <box
          paddingTop={position === "bottom" ? 1 : 0}
          paddingBottom={position === "top" ? 1 : 0}
        >
          <text fg={c().text} onMouseUp={() => setFolded(!folded())}>
            {folded() ? "\u25b8 " : "\u25be "}
            <b>Model router</b>
            <span
              style={{ fg: c().muted }}
            >{` \u00b7 ${modeText(p().mode)}`}</span>
          </text>
          <For each={folded() ? [] : p().rows}>
            {(row) => (
              <box>
                <text fg={c().text}>
                  {`  ${row.agent.padEnd(agentWidth())}  `}
                  <span style={{ fg: row.changed ? c().changed : c().muted }}>
                    {row.models}
                  </span>
                </text>
                <text fg={c().muted}>{`    ${row.why}`}</text>
              </box>
            )}
          </For>
          <For each={folded() ? [] : footer()}>
            {(line) => <text fg={c().muted}>{line}</text>}
          </For>
        </box>
      </Show>
    )
  }

  if (sidebar !== "off")
    host.sidebar(position, sidebar === "full" ? full : compact)

  const report = (what: string, result: { ok: boolean; reason?: string }) =>
    host.toast(
      result.ok
        ? {
            variant: "success",
            title: "Advisor",
            message: `${what}. Live within a few seconds.`,
          }
        : {
            variant: "error",
            title: "Not changed",
            message: result.reason ?? what,
          },
    )

  // Dry run of a hint line or task id: what the router would decide, and why.
  const check = async (line: string) => {
    const v2 = loadConfig().v2
    const result = await checkDecision(line, v2, {
      explain,
      parseHint: (text) =>
        /\[\[\s*route\s*:/i.test(text)
          ? hintFacts(parseMarkers(text).hint)
          : parseHintFacts(text),
      connectors: createConnectors(v2.connectors),
    })
    await host.alert(
      result.ok ? "Model router: check" : "Model router: check failed",
      result.lines.join("\n"),
    )
  }

  // Every config change from here is validated, and backed up before it is written.
  const save = (what: string, path: Path, value: unknown) => {
    const cfg = loadConfig()
    const result = editValidated(path, value, configPath(), {
      mode: cfg.mode,
      v2: cfg.v2,
    })
    host.toast(
      result.ok
        ? {
            variant: "success",
            title: "Saved",
            message: `${what}.${result.backup ? ` Backup ${basename(result.backup)}.` : ""} Live within a few seconds.`,
          }
        : { variant: "error", title: "Not saved", message: result.reason },
    )
    return result.ok
  }

  const editRow = async (row: SettingRow) => {
    let action = "edit"
    if (row.removable) {
      const picked = await host.select(row.title, [
        { title: "Edit", value: "edit" },
        { title: "Remove", value: "remove" },
      ])
      if (!picked) return
      action = picked
    }
    if (action === "remove") {
      save(`${row.title} removed`, row.path, undefined)
      return
    }
    const raw = row.choices
      ? await host.select(
          row.title,
          row.choices.map((c) => ({
            title: c,
            value: c,
            description: c === row.shown ? "current" : undefined,
          })),
        )
      : await host.prompt(row.title, {
          placeholder: row.kind,
          value: row.initial,
        })
    if (raw === undefined) return
    const parsed = parseSettingValue(row.kind, raw)
    if (!parsed.ok)
      return host.toast({
        variant: "error",
        title: "Not saved",
        message: parsed.reason,
      })
    save(`${row.title} set`, row.path, parsed.value)
  }

  const settings = async (id: string) => {
    const section = SECTIONS.find((s) => s.id === id)?.id
    if (!section) return
    const name = SECTIONS.find((s) => s.id === section)?.title ?? section
    for (;;) {
      const row = await host.select(
        `Settings: ${name}`,
        settingRows(section, loadConfig()).map((r) => ({
          title: r.title,
          value: r,
          description: r.shown,
        })),
      )
      if (!row) return
      await editRow(row)
    }
  }

  // Suggestions are the operator's to apply, one at a time, through the same validated edit.
  const readCalibration = () => {
    try {
      return parseCalibration(readFileSync(calibrationFile(), "utf8"))
    } catch {
      return undefined
    }
  }

  const calibrate = async (pick: string) => {
    const c = readCalibration()
    if (!c)
      return host.toast({
        variant: "info",
        title: "Calibration",
        message: "No calibration yet. Run the calibrate command first.",
      })
    if (pick === "report")
      return host.alert(
        "Calibration",
        calibrationReport(c, loadConfig().v2.levels).join("\n"),
      )
    const option = suggestionOptions(c).find((o) => o.value === pick)
    const s = c.suggestions.find((x) => x.id === pick)
    if (!option || !s) return
    if (!option.applicable) return host.alert(s.path, s.why)
    const edit = suggestionEdit(s, loadConfig())
    if (!edit.ok)
      return host.toast({
        variant: "error",
        title: "Not applied",
        message: edit.reason,
      })
    if (
      await host.confirm(
        "Apply suggestion?",
        `${suggestionTitle(s)}\n${s.why}\n(${s.path}: ${s.from} → ${s.to})`,
      )
    )
      save(`${s.path} set to ${s.to}`, edit.path, edit.value)
  }

  const sessionId = () => host.currentSession() ?? lastSession
  const show = (title: string, lines: string[]) =>
    host.alert(title, lines.join("\n"))

  // What the sub-commands read and do; the registry in src/commands.ts owns the rest.
  const deps: Deps = {
    agents: () => {
      const pins = readPins()
      const agents = new Set<string>(Object.keys(pins))
      for (const r of reader.read())
        if (r.kind === "decision") agents.add(r.agent)
      return [...agents]
        .filter((a) => !a.startsWith("session:"))
        .map((a) => ({
          title: a,
          value: a,
          description: pins[a] ? `pinned to ${pins[a]}` : undefined,
        }))
    },
    tiers: () => {
      const config = loadConfig()
      return config.ladder.map((tier) => ({
        title: tier,
        value: tier,
        description: config.tiers[tier],
      }))
    },
    pins: () =>
      Object.entries(readPins()).map(([k, tier]) => ({
        title: k,
        value: k,
        description: tier,
      })),
    decisions: () => decisionRows(reader.read(), 20, ruleLabels(loadConfig())),
    calibration: () => {
      const c = readCalibration()
      return c
        ? [
            { title: "Show report", value: "report", category: "Report" },
            ...suggestionOptions(c),
          ]
        : []
    },
    sections: () =>
      SECTIONS.map((x) => ({
        title: x.title,
        value: x.id,
        description: x.description,
      })),
    mode: () => loadConfig().mode,
    show,
    sessionLines: () => {
      const id = sessionId()
      return id
        ? sessionLines(reader.read(), id, ruleLabels(loadConfig()))
        : ["Open a session first."]
    },
    rulesLines: () => rulesLines(loadConfig()),
    alertLines: () =>
      alertLines(reader.read(), 20, alertContextOf(loadConfig())),
    decisionDetail: (id) =>
      decisionDetail(reader.read(), id, ruleLabels(loadConfig())),
    setMode: async (next) => {
      if (next === loadConfig().mode)
        return host.toast({
          variant: "info",
          title: "Advisor",
          message: `Mode is already ${next}.`,
        })
      if (
        next === "enforce" &&
        !(await host.confirm(
          "Switch to enforce?",
          "Subagents will run on the model the router picks. Run /advisor mode shadow to go back.",
        ))
      )
        return
      report(`Mode is now ${next}`, setMode(next as "shadow" | "enforce"))
    },
    pin: (target, tier) => {
      const id = sessionId()
      if (target === "session" && !id)
        return host.toast({
          variant: "warning",
          title: "No session",
          message: "Open a session first.",
        })
      const key = target === "session" ? `session:${id}` : target
      const label = target === "session" ? "this session" : target
      report(`${label} pinned to ${tier}`, setPin(key, tier))
    },
    unpin: (target) => report(`${target} unpinned`, setPin(target, undefined)),
    check,
    settings,
    calibrate,
    openAlert: () =>
      lastAlert
        ? host.open(lastAlert)
        : host.toast({
            variant: "info",
            title: "Advisor",
            message: "No alert since the TUI started.",
          }),
  }

  const ui: Ui = {
    select: ({ title, options, ...extra }) =>
      host.select(title, options, extra),
    prompt: ({ title, ...options }) => host.prompt(title, options),
    toast: ({ title, message, variant }) =>
      host.toast({ title, message, variant }),
  }

  const go = async (input: string) => {
    try {
      await dispatch(input, SUBS, deps, ui)
    } catch (err) {
      host.toast({
        variant: "error",
        title: "Advisor",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  function openPicker(session?: string) {
    if (session) lastSession = session
    void go("")
  }

  // The host completes only a slash command's name, so each sub-command is its
  // own entry (and appears in the palette through it); bare /advisor is the picker.
  host.commands([
    {
      id: "model-advisor.open",
      title: "Model router",
      description: "Pick a sub-command: /advisor help lists them all",
      slash: "advisor",
      run: (input) => void go(input ?? ""),
    },
    ...slashEntries(SUBS).map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      slash: e.name,
      run: (input?: string) => void go(forward(e.sub, input)),
    })),
  ])

  return () => clearInterval(timer)
}

type V2Context = Plugin.Context

// V2 theme leaves are a colour or a { base, ... } state set.
const colour = (value: any) =>
  value && typeof value === "object" && "base" in value ? value.base : value

function hostV2(ctx: V2Context): Host {
  const theme = ctx.theme as any
  return {
    colours: () => ({
      text: colour(theme.text?.base),
      muted: colour(theme.text?.muted),
      changed: colour(theme.text?.feedback?.warning),
      good: colour(theme.text?.feedback?.success),
    }),
    currentSession: () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    },
    sidebar: (position, render) =>
      ctx.ui.slot(
        position === "top"
          ? { prepend: "sidebar.content", render: (s) => render(s.sessionID) }
          : { append: "sidebar.content", render: (s) => render(s.sessionID) },
      ),
    commands: (list) =>
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: list.map((c) => ({
          id: c.id,
          title: c.title,
          group: "Advisor",
          palette: true as const,
          description: c.description,
          slash: { name: c.slash, arguments: true as const },
          bind: false as const,
          run: (input?: string) => void c.run(input),
        })),
        bindings: [],
      })),
    select: (title, options, extra) =>
      ctx.ui.dialog.select({ title, options, ...extra } as never),
    confirm: async (title, message) =>
      (await ctx.ui.dialog.confirm({ title, message })) === true,
    alert: (title, message) => ctx.ui.dialog.alert({ title, message }),
    prompt: (title, options) =>
      ctx.ui.dialog.prompt({
        title,
        ...(options?.description ? { description: options.description } : {}),
        ...(options?.placeholder ? { placeholder: options.placeholder } : {}),
        ...(options?.value ? { value: options.value } : {}),
      }),
    toast: (toast) => ctx.ui.toast.show(toast),
    session: async (id) => {
      const info =
        ctx.data.session.get(id) ??
        (await ctx.client.session.get({ sessionID: id }).catch(() => undefined))
      return info
        ? { title: info.title, directory: info.location?.directory }
        : undefined
    },
    open: (sessionID) => ctx.ui.router.navigate({ type: "session", sessionID }),
    attention: (title, message) =>
      void ctx.attention
        .notify({
          title,
          message,
          notification: { when: "blurred" },
          sound: false,
        })
        .catch(() => {}),
  }
}

function hostV1(api: TuiPluginApi): Host {
  return {
    colours: () => ({
      text: api.theme.current.text,
      muted: api.theme.current.textMuted,
      changed: api.theme.current.warning,
      good: api.theme.current.success,
    }),
    currentSession: () => undefined,
    sidebar: (position, render) => {
      api.slots.register({
        // Lower renders first.
        order: position === "top" ? 1 : 900,
        slots: {
          sidebar_content(_ctx, props: { session_id: string }) {
            return render(props.session_id)
          },
        },
      })
    },
    commands: (list) =>
      api.keymap.registerLayer({
        commands: list.map((c) => ({
          name: c.id,
          title: c.title,
          category: "Advisor",
          namespace: "palette",
          slashName: c.slash,
          run: () => c.run(),
        })),
        bindings: [],
      }),
    select: (title, options, extra) =>
      new Promise((resolve) => {
        let done = false
        const finish = (value: any) => {
          if (done) return
          done = true
          resolve(value)
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogSelect
              title={title}
              options={options}
              current={extra?.current}
              placeholder={extra?.placeholder}
              onSelect={(option) => {
                finish(option.value)
                api.ui.dialog.clear()
              }}
            />
          ),
          () => finish(undefined),
        )
      }),
    confirm: (title, message) =>
      new Promise((resolve) => {
        let done = false
        const finish = (value: boolean) => {
          if (done) return
          done = true
          resolve(value)
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogConfirm
              title={title}
              message={message}
              onConfirm={() => {
                finish(true)
                api.ui.dialog.clear()
              }}
              onCancel={() => {
                finish(false)
                api.ui.dialog.clear()
              }}
            />
          ),
          () => finish(false),
        )
      }),
    alert: (title, message) =>
      new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogAlert
              title={title}
              message={message}
              onConfirm={() => {
                finish()
                api.ui.dialog.clear()
              }}
            />
          ),
          finish,
        )
      }),
    prompt: (title, options) =>
      new Promise((resolve) => {
        let done = false
        const finish = (value: string | undefined) => {
          if (done) return
          done = true
          resolve(value)
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogPrompt
              title={title}
              placeholder={options?.placeholder}
              value={options?.value}
              onConfirm={(value) => {
                finish(value)
                api.ui.dialog.clear()
              }}
              onCancel={() => {
                finish(undefined)
                api.ui.dialog.clear()
              }}
            />
          ),
          () => finish(undefined),
        )
      }),
    toast: ({ title, message, variant }) =>
      api.ui.toast({ title, message, variant }),
    session: async (id) => {
      const info = api.state.session.get(id)
      return info ? { title: info.title, directory: info.directory } : undefined
    },
    open: (sessionID) => api.route.navigate("session", { sessionID }),
    attention: (title, message) =>
      void api.attention
        ?.notify({
          title,
          message,
          notification: { when: "blurred" },
          sound: false,
        })
        .catch(() => {}),
  }
}

const tui: TuiPlugin = async (api) => {
  api.lifecycle.onDispose(start(hostV1(api)))
}

const plugin: TuiPluginModule & {
  id: string
  setup: (ctx: V2Context) => () => void
} = {
  id: "model-advisor.tui",
  tui,
  setup: (ctx) => start(hostV2(ctx)),
}
export default plugin
