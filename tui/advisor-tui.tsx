/** @jsxImportSource @opentui/solid */
/**
 * The router's TUI: a sidebar line per session, three commands and alert toasts.
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
import { createSignal, For, Show } from "solid-js"

import { buildConfig, configPath, defaultConfig } from "../dist/config.js"
import { readPins, setMode, setPin } from "../dist/config-edit.js"
import { RecordReader } from "../dist/decisions.js"
import { parseJsonc } from "../dist/jsonc.js"
import {
  alertToast,
  AlertWatcher,
  decisionRows,
  sidebarLines,
} from "../dist/view.js"

type Option<T> = {
  title: string
  value: T
  description?: string
  category?: string
}
type Toast = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
}
type Command = { id: string; title: string; slash: string; run: () => void }

type Host = {
  muted: () => unknown
  currentSession: () => string | undefined
  sidebar: (render: (session: string) => JSX.Element) => void
  commands: (list: Command[]) => void
  select: <T>(title: string, options: Option<T>[]) => Promise<T | undefined>
  confirm: (title: string, message: string) => Promise<boolean>
  toast: (toast: Toast) => void
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
  const watcher = new AlertWatcher()
  const [records, setRecords] = createSignal(reader.read())
  watcher.fresh(reader.read())
  let lastSession: string | undefined

  // The reader hands back the same array while the file is unchanged, so the
  // signal only fires on a write.
  const timer = setInterval(() => {
    const all = reader.read()
    setRecords(all)
    for (const alert of watcher.fresh(all)) host.toast(alertToast(alert))
  }, 2000)

  host.sidebar((session) => {
    lastSession = session
    const lines = () => sidebarLines(records(), session)
    return (
      <Show when={lines().length > 0}>
        <box>
          <For each={lines()}>
            {(line) => <text fg={host.muted() as never}>{line}</text>}
          </For>
        </box>
      </Show>
    )
  })

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

  const pickTier = async (title: string) => {
    const config = loadConfig()
    return host.select(
      title,
      config.ladder.map((tier) => ({
        title: tier,
        value: tier,
        description: config.tiers[tier],
      })),
    )
  }

  const pin = async (key: string, label: string) => {
    const tier = await pickTier(`Pin ${label} to`)
    if (tier) report(`${label} pinned to ${tier}`, setPin(key, tier))
  }

  const pinCommand = async () => {
    const pins = readPins()
    const action = await host.select("Advisor pin", [
      { title: "Pin an agent", value: "agent" },
      { title: "Pin this session", value: "session" },
      {
        title: "Unpin",
        value: "unpin",
        description: `${Object.keys(pins).length} pinned`,
      },
    ])
    if (action === "agent") {
      const agents = new Set<string>(Object.keys(pins))
      for (const r of reader.read())
        if (r.kind === "decision") agents.add(r.agent)
      const agent = await host.select(
        "Pin which agent",
        [...agents]
          .filter((a) => !a.startsWith("session:"))
          .map((a) => ({ title: a, value: a, description: pins[a] })),
      )
      if (agent) await pin(agent, agent)
    } else if (action === "session") {
      const id = host.currentSession() ?? lastSession
      if (!id)
        return host.toast({
          variant: "warning",
          title: "No session",
          message: "Open a session first.",
        })
      await pin(`session:${id}`, "this session")
    } else if (action === "unpin") {
      const key = await host.select(
        "Unpin",
        Object.entries(pins).map(([k, tier]) => ({
          title: k,
          value: k,
          description: tier,
        })),
      )
      if (key) report(`${key} unpinned`, setPin(key, undefined))
    }
  }

  host.commands([
    {
      id: "model-advisor.mode",
      title: "advisor: mode",
      slash: "advisor-mode",
      run: async () => {
        const next = loadConfig().mode === "shadow" ? "enforce" : "shadow"
        if (
          next === "enforce" &&
          !(await host.confirm(
            "Switch to enforce?",
            "Subagents will run on the model the router picks. Run the command again to go back to shadow.",
          ))
        )
          return
        report(`Mode is now ${next}`, setMode(next))
      },
    },
    {
      id: "model-advisor.pin",
      title: "advisor: pin",
      slash: "advisor-pin",
      run: () => void pinCommand(),
    },
    {
      id: "model-advisor.decisions",
      title: "advisor: decisions",
      slash: "advisor-decisions",
      run: async () => {
        const rows = decisionRows(reader.read(), 20)
        if (rows.length === 0)
          return host.toast({
            variant: "info",
            title: "Advisor",
            message: "No decisions yet.",
          })
        await host.select("Last 20 decisions", rows)
      },
    },
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
    muted: () => colour(theme.text?.muted),
    currentSession: () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    },
    sidebar: (render) =>
      ctx.ui.slot({
        append: "sidebar.content",
        render: (slot) => render(slot.sessionID),
      }),
    commands: (list) =>
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: list.map((c) => ({
          id: c.id,
          title: c.title,
          group: "Advisor",
          palette: true as const,
          slash: { name: c.slash },
          bind: false as const,
          run: () => void c.run(),
        })),
        bindings: [],
      })),
    select: (title, options) => ctx.ui.dialog.select({ title, options }),
    confirm: async (title, message) =>
      (await ctx.ui.dialog.confirm({ title, message })) === true,
    toast: (toast) => ctx.ui.toast.show(toast),
  }
}

function hostV1(api: TuiPluginApi): Host {
  return {
    muted: () => api.theme.current.textMuted,
    currentSession: () => undefined,
    sidebar: (render) => {
      api.slots.register({
        order: 215,
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
    select: (title, options) =>
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
    toast: (toast) => api.ui.toast(toast),
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
