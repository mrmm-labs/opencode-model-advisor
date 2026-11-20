# opencode-model-advisor

An OpenCode plugin that chooses the model for each subagent dispatch, and records why.

Subagents inherit their parent's model unless something sets one. An Opus orchestrator turns every
worker into Opus, and nothing says why a dispatch got the model it got. This plugin picks the model
once, when the task is dispatched, from rules you write, an optional Haiku judge and a default. It
starts in **shadow mode**: it records what it would do and changes nothing.

This implements [the design](docs/spec.md): the router and its telemetry, a TUI, and the advisor tool
(a stronger model a cheaper executor can consult mid-task), which is off by default.

## Roles

| Role       | Job                                                                      |
| ---------- | ------------------------------------------------------------------------ |
| Executor   | Runs the task. Its model is what the router chooses.                     |
| Router     | Picks the executor model for a new dispatch: rules first, judge second.  |
| Judge      | Classifies one task into a tier (Haiku). Runs only when no rule matched. |
| Escalation | After a reported failure, the next dispatch goes one tier up, once.      |
| Operator   | Pins, prompt overrides, the shadow/enforce switch.                       |
| Observer   | Spans and metrics for every decision. Alerts, never blocks.              |

Orchestrators (the `orchestrators` list) and dispatches with no agent are never routed.
Continuing an existing child session is never re-routed.

## Install

Needs OpenCode 2. OpenCode 1 works too, with fewer features (see Limitations).

```sh
mise install && mise run build   # or: pnpm install && pnpm run build (Node 24, pnpm 10)
```

Put the folder where OpenCode loads plugins from (OpenCode 2 wants a directory with an `index.js`),
or list the published package in your OpenCode config:

```jsonc
{ "plugins": ["opencode-model-advisor"] }
```

Then copy [`model-advisor.example.jsonc`](model-advisor.example.jsonc) to
`~/.config/opencode/model-advisor.jsonc`. Without a config file the plugin runs in shadow mode with
no rules and no judge, which records every dispatch under the default tier.

## How a dispatch is routed

First match wins:

1. **Pin.** Config `pins`: `"<agent>": "<tier>"` or `"session:<id>": "<tier>"` (the dispatching session).
2. **Override marker.** `[[advisor: opus]]` anywhere in the prompt. A tier name or a model fragment.
3. **Escalation.** The hint says `retry>=1`: one tier above the tier last chosen for that `task` in this
   process, or above the rule result when the task is new. At `retry>=2` it stops climbing, keeps
   the tier and raises an alert.
4. **Rules.** In config order. Match on `agent`, `prompt` (regex), `prompt.length`, and the hint
   fields `hint.task`, `hint.tier`, `hint.retry`, `hint.files`. Numeric fields take `">=15"` style
   comparisons; a list means any of. An optional `label` is the short sentence the sidebar shows
   as the reason (`"label": "touches billing"`).
5. **Judge.** Haiku reads the first 4000 characters of the prompt and answers `{tier, reason}`. Any
   failure gives the default tier with source `judge-failed`.
6. **Default tier.**

The router overrides any model the caller passed.

### Hint line

One optional line anywhere in the dispatch prompt:

```
[[route: task=1047 tier=high retry=1 files=12]]
```

All fields are optional and unknown ones are ignored. `task` keys escalation, `tier` is the caller's
own classification (`low|medium|high|critical`), `retry` counts failed attempts. In enforce mode the
line (and any `[[advisor: ...]]` marker) is removed before the prompt reaches the subagent. In shadow
mode nothing is changed.

## Shadow, then enforce

`mode: "shadow"` (the default) records `route.would` beside the model actually used and changes
nothing. Run it for a while, look at the dashboard, then set `"mode": "enforce"`. Enforce sets the
subagent's model (only when it differs from the caller's) and strips the markers. The config is
re-read when its modification time changes; no restart.

The judge works in both modes. In shadow it still makes its call so `would` is accurate.

## Configuration

`~/.config/opencode/model-advisor.jsonc` (JSONC), or the path in `OPENCODE_MODEL_ADVISOR_CONFIG`.
Invalid parts fall back to defaults and a warning goes to the log.

| Key             | Default                        | Meaning                                                                             |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `mode`          | `shadow`                       | `shadow` or `enforce`                                                               |
| `provider`      | `anthropic`                    | Provider id for tiers that name a bare model id                                     |
| `tiers`         | haiku, sonnet, opus (5.5)      | Tier name to model id. Key order is the ladder, cheapest first                      |
| `default`       | `sonnet`                       | Tier when nothing else decides                                                      |
| `orchestrators` | `build`, `plan`, `coordinator` | Agents that are never routed                                                        |
| `pins`          | none                           | Agent name or `session:<id>` to tier                                                |
| `rules`         | none                           | `{ id, when, tier, label? }`, see above                                             |
| `judge`         | disabled, haiku, 8000 ms       | `{ enabled, model, timeoutMs }`                                                     |
| `advisor`       | disabled, top tier, 2 uses     | `{ enabled, model, maxUses, maxContextTokens, alertSteps }`, see Advising           |
| `tui.sidebar`   | `compact`                      | Session sidebar block: `compact` (3 rows), `full` (one entry per decision) or `off` |
| `tui.position`  | `bottom`                       | Where the block sits in the session sidebar: `top` or `bottom`                      |
| `otel.endpoint` | env or off                     | OTLP/HTTP base URL; `OTEL_EXPORTER_OTLP_ENDPOINT` is the fallback                   |

`otel.headers` adds request headers (for an authenticated collector). The log is
`~/.local/share/opencode/model-advisor/advisor.log` (`OPENCODE_MODEL_ADVISOR_LOG` overrides it).

### The judge

On OpenCode 2 the judge is one `ctx.generate.text` call: it goes through OpenCode's own provider and
credentials, and the plugin never reads a key. The reply must name a configured tier, so the judge
cannot pick a model outside your list. The task text is wrapped as data, but it is still text from
your agents: treat the judge as a hint, with rules and pins above it.

It is off by default because every dispatch no rule matched costs one extra short call, and in shadow
mode that is pure overhead until you read the results.

## Routing v2

Off by default (`v2.enabled: false`): everything above is unchanged. When on, the router stops
reading one tier and scores the task instead. A dispatch is described by **facts**, the facts give a
**difficulty** score, and a **risk × difficulty** matrix picks a **level**. Each level maps to a model
from any provider. Design: [docs/spec-routing-v2.md](docs/spec-routing-v2.md).

Order: pin, then the override marker (`[[advisor: frontier]]` takes a level name or a model fragment),
then v2. The v1 `rules`, the judge and the `default` tier are not consulted, with one exception: a rule
that matches on `agent` alone acts as a floor. Its tier is read by position (second tier on the ladder
means second level), and the level never ends up below it.

```
[[route: task=1047 risk=high files=12 modules=3 kind=edit migration=no unknowns=2 retry=1]]
```

`tier=` still works as an alias of `risk` (`T1`, `T2`, `T3` map to high, medium, low). Missing facts take
the config default. The plugin adds `promptTokens` (characters / 4), `paths` (path-like words in the
prompt, at most 20) and `priorFailures` (the `retry` count, only when this process already dispatched
the same `task`).

Each fact keeps its source. The strongest source wins: override, connector, caller, plugin, default.
`risk` is the exception: the highest value from any source wins. When sources disagree, the losing
values are stored on the decision and a `fact-disagreement` alert is recorded.

After the matrix, the **risk floor** lifts the level, then each retry climbs `retryStep` levels (capped
at the top). An operator override or a connector's override level beats all of it.

```jsonc
{
  "v2": {
    "enabled": true,
    "levels": {
      "fast": { "model": "anthropic/claude-haiku-5-5" },
      "standard": { "model": "anthropic/claude-sonnet-5-5" },
      "frontier": { "model": "anthropic/claude-opus-5-5" },
    },
    "difficulty": {
      "points": [
        { "fact": "files", "gte": 15, "add": 2 },
        { "fact": "modules", "gte": 3, "add": 2 },
        { "fact": "migration", "eq": true, "add": 2 },
        { "fact": "kind", "in": ["new", "refactor"], "add": 1 },
        { "fact": "unknowns", "per": 1, "add": 1, "max": 3 },
        { "fact": "priorFailures", "per": 1, "add": 2 },
      ],
      "cutoffs": { "medium": 2, "high": 4 },
    },
    "policy": {
      "matrix": {
        "low": { "low": "fast", "medium": "standard", "high": "frontier" },
      },
      "riskFloor": { "high": "frontier", "critical": "frontier" },
      "retryStep": 1,
    },
    "defaults": { "risk": "medium" },
    "connectors": [
      {
        "id": "tracker",
        "match": { "task": "^\\d+$" },
        "command": ["gh", "issue", "view", "{task}", "--json", "labels"],
        "timeoutMs": 3000,
        "ttlMinutes": 360,
        "map": [
          { "label": "^risk:high$", "set": { "risk": "high" } },
          { "label": "^route:frontier$", "override": { "level": "frontier" } },
        ],
      },
    ],
  },
}
```

Every key is optional and merges over the defaults shown in the spec (`matrix` merges cell by cell).
A level name in `matrix`, `riskFloor`, `levelOrder` or `advisor.level` that is not in `levels` is
refused with a warning; if that leaves the policy pointing at a missing level (custom `levels` without
a matching `matrix`), v2 stays off. `levelOrder` defaults to the key order of `levels`, cheapest first.
A connector needs `timeoutMs` of at most 10000 (default 3000) and a `command` or `http` source.

The decision record carries the facts with their sources, the score breakdown, each step the policy
took and the connector outcomes (`v2` in `decisions.jsonl`). Paths found in the prompt are stored
as facts; the prompt text itself never is, only a short summary of the task (below).

## Advising

With `advisor.enabled: true` and `mode: "enforce"`, a cheaper model's requests get the Anthropic
`advisor_20260301` tool, so the executor can consult a stronger model (by default the top tier)
before committing to an approach, when an error repeats, and before declaring the task done.

```jsonc
"advisor": { "enabled": true, "model": "claude-opus-5-5", "maxUses": 2, "maxContextTokens": 120000, "alertSteps": 15 }
```

A request gets the advisor when all of these hold:

- the advisor is enabled and the mode is `enforce` (in shadow mode nothing is attached; the first
  request of each session records `advisor.would_attach` so you can see what enforcing would do);
- the executor's model is below the advisor model on the tier ladder;
- the agent is set and is not an orchestrator, and the request is not a judge call;
- the estimated context is under `maxContextTokens`. The estimate is the JSON body length divided by
  four. An advisor call reads the whole transcript uncached, so its cost grows with the context;
- the API has not already refused this executor and advisor pair in this process.

Attaching adds the tool (`max_uses` = `maxUses`), merges `advisor-tool-2026-03-01` into the
`anthropic-beta` header, and appends one line to the last system text block telling the model when to
consult. The tool definition and the line are the same on every request, so the prompt cache is not
invalidated. If the context outgrows the limit mid-session the tool is left off from then on, which
does change the prefix once.

**The response filter.** OpenCode cannot round-trip the advisor's server tool result: the turn after
an advisor call fails with `Anthropic Messages does not know how to round-trip server tool result for
advisor`. So the plugin filters every response to a request it attached the advisor to. It drops the
`advisor` `server_tool_use` and `advisor_tool_result` blocks (their start, delta and stop events),
renumbers the remaining block indexes, and removes `advisor_message` entries from `usage.iterations`
(the top-level token counts become the executor's own). Everything else passes through byte for byte,
chunk by chunk. The advice is encrypted and is not kept in history; it shapes only the turn it was
given in. `pnpm run test:integration` runs two turns of one session through a real OpenCode, with and
without the filter, to show both outcomes; it also covers shadow mode and a refused pairing.

**A refused pairing** (a 400 that names the advisor, the tool type or the beta) is resent once
without the tool, the header value and the system line; the turn does not fail. The pair is then left
alone for the rest of the process, and an alert is raised.

**Where it hooks in.** A plugin cannot reach the Messages request on its own, so this runs as hooks
on the request path of [opencode-claude-accounts](https://github.com/mrmm-labs/opencode-claude-accounts).
The contract is a registry on `globalThis`, created by whichever plugin loads first:

```ts
globalThis.__claudeAccountsHooks ??= { before: [], response: [] }
// before:   (req) => void | Promise<void>                       mutate req.body / req.headers in place
// response: (res, ctx) => Response | Promise<Response>          may wrap the stream; ctx.resend(body) sends again
// req = { url, body, headers, model, agent?, sessionID? }
```

This plugin registers once per process, however many project instances load it. If nothing ever
calls the hooks, advising never happens, and the log gets one `advisor_hooks_idle` line a minute
after start.

Observer output: a span `advisor <agent>` per request with advisor calls, the metrics below, a
line in `/advisor` (`advisor 2 calls $0.04`), and the decisions list. Alerts (toast, never blocking): the
advisor was refused, or an executor below the advisor tier ran a turn of more than `alertSteps`
steps with no advisor attached (enforce mode).

## TUI

A directory plugin that has a `tui.tsx` next to its `index.js` gets the TUI loaded by OpenCode 2
(the build needs `pnpm run build` first, because the TUI imports from `dist/`). Restart the TUI to
pick it up; the server plugin does not need a restart.

- **Sidebar** (`tui.sidebar`, restart the TUI after changing it): by default a compact section, a
  title and at most four rows in plain words, appended to the sidebar so another plugin can still
  claim the top (`tui.position: "top"` prepends it instead).

  ```
  Model router · watching only
    Last task  builder · opus 5.5
    Why        touches auth / security
    Suggested  sonnet 5.5 — cheaper
    Today      would save ≈ $1.50
  ```

  The title says what the router is doing: `watching only` (mode `shadow`) or `choosing models`
  (`enforce`). `Last task` is the agent of the latest dispatch and the model it ran on. `Why` is the
  reason: the rule's `label` if it has one, else a built-in sentence (`marked critical`, `touches
auth / security`, `15+ files`, `security review`, `read-only agent`, `no rule matched`, `retry
after a failure`, `judged by the advisor`), or for routing v2 the risk and difficulty (`medium
risk, low difficulty`). `Suggested` is what the router picks, with `cheaper` or `stronger`; it is
  left out when the pick is the model that ran. `Today` is the estimated saving since midnight
  across all sessions: `would save` in shadow mode, `saved` in enforce mode (against the model the
  caller asked for), `cost ... more` when it is a net loss; `≈` marks an estimate priced at list.
  A row with no data is left out. A routed subagent session shows its own decision; the session that
  dispatched it shows its latest. Click the title, or run `/advisor`, for everything else. The
  slot API has no tooltips, so there is no hover text.

  `"full"` is the earlier block: one entry per decision, newest first, at most four, then a `+N more`
  line; click the heading to fold it.

  ```
  ▾ Model router shadow
    general  sonnet → opus
      critical
    explore  sonnet
      read-only
  ```

  `sonnet → opus` (highlighted) is what ran, then what the router picks; one model means they
  agree. `"off"` shows no sidebar block.

- **One command, `/advisor`.** Click the sidebar title or type `/advisor` for a searchable picker of
  every sub-command (name, what it does, and its usage line underneath). Picking one asks for its
  arguments in order: a picker of the live values (the current one marked) or a prompt with a
  placeholder, prefilled where there is a default. Esc at any step cancels with nothing changed.
  The typed form is the fast path: `/advisor pin builder opus` runs at once, `/advisor pin` asks
  only for the missing arguments, `/advisor pi` runs the one sub-command it matches (or opens the
  picker narrowed to the ones it could mean), and a bad value says what is valid and reopens that
  argument's picker. OpenCode completes a slash command's name but not what follows it, so the
  picker is the completion list.

  <!-- commands:start -->

  | Command                         | What it does                                                            |
  | ------------------------------- | ----------------------------------------------------------------------- |
  | `/advisor`                      | Open the picker                                                         |
  | `/advisor session`              | Decisions and advisor usage of the session you are in                   |
  | `/advisor rules`                | Rules, pins and the default tier                                        |
  | `/advisor alerts`               | Recent alerts, newest first                                             |
  | `/advisor decisions <decision>` | The last 20 decisions; pick one for the full reason                     |
  | `/advisor calibration <item>`   | The calibration report, and suggestions to apply                        |
  | `/advisor mode <mode>`          | Watching only (shadow) or choosing models (enforce); enforce asks first |
  | `/advisor pin <target> <tier>`  | Pin an agent, or this session, to a tier                                |
  | `/advisor unpin <target>`       | Remove a pin                                                            |
  | `/advisor settings <section>`   | Edit routing settings, one section at a time                            |
  | `/advisor check <input...>`     | Dry run: what the router would decide for a hint line or a task id      |
  | `/advisor alert`                | Go to the session the latest alert was about                            |
  | `/advisor help`                 | List every sub-command with its usage                                   |

  <!-- commands:end -->

  `settings` walks the rows of the section you pick, and `calibration` takes `report` or a
  suggestion to apply. `mode enforce` asks first. Each sub-command is also in the command palette as
  `advisor: <name>`.

  Migrating from the earlier commands: `/advisor-mode` is `/advisor mode <shadow|enforce>` (it
  used to toggle), `/advisor-pin` is `/advisor pin <target> <tier>` and `/advisor unpin <target>`,
  `/advisor-decisions` is `/advisor decisions`, `/advisor-alert` is `/advisor alert`,
  `/advisor-check` is `/advisor check <input...>`, `/advisor-settings` is
  `/advisor settings <section>`, `/advisor-calibration` is `/advisor calibration <item>`. The picker's
  old _This session_, _Rules_ and _Alerts_ entries are `/advisor session`, `rules` and `alerts`. The
  `/advisor-*` names are gone.

- **Toasts** for alerts: a task failing twice, facts disagreeing, the judge failing, the advisor
  refused. Alerts never block anything. A toast says who, where, what and what the router did:

  ```
  Model router · approver failed twice
  Fix billing · acme-api
  Approve the migration of the billing tables
  Retrying on opus 5.5 (strongest)
  ```

  Lines: the agent; the dispatching session's title and project folder; the task (its summary);
  what the router did, in words (`Would retry on …` in shadow mode). The raw score and matrix stay
  in `/advisor alerts`. The toast passes its session to OpenCode, which offers to open it when
  that session's family is not the one on screen: the subagent's session if it exists yet, else the
  dispatching one. OpenCode's toast has no custom action, so that offer is the host's own.
  **`/advisor alert`** opens that session whenever you like. When the
  terminal is not in focus, the alert is also sent to OpenCode's attention API (a system
  notification, no sound).

The TUI is a separate process from the server plugin, so the two share files only. The plugin
appends one line per decision to `decisions.jsonl` next to `advisor.log` (rolled to `.1` past 256 KB;
no prompt text, only a one-line `summary` of the task (the task tool's description, else the first
80 characters of the prompt, with anything that looks like a credential replaced by `[secret]`),
reasons cut to 200 characters; `OPENCODE_MODEL_ADVISOR_DECISIONS` overrides the
path). The TUI reads it, and changes behaviour only by editing `model-advisor.jsonc` (`mode`,
`pins`): one top-level value is replaced, through a temp file and a rename, and every comment in the
file stays. The plugin picks the change up on its next config re-read.

OpenCode loads the plugin once per open project in the same process. Decisions are de-duplicated by
tool call id, so each dispatch is recorded and counted once.

## Telemetry

Off until `otel.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No dependencies: spans and
metrics are posted as OTLP/HTTP JSON, batched every two seconds, flushed on shutdown, and a failed
post is dropped. Prompt text is never exported. The service is `opencode/model-advisor`.

**Span** `route <agent>`, one per decision. Its trace id is the root session's, computed the way
[opencode-claude-accounts](https://github.com/mrmm-labs/opencode-claude-accounts) does, so both
plugins' spans for one session tree land in one trace.

| Attribute                                      | Meaning                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `session.id`                                   | The dispatching session                                                     |
| `opencode.agent`                               | The target agent                                                            |
| `route.mode`                                   | `shadow` or `enforce`                                                       |
| `route.model`                                  | The model applied, or the caller's in shadow                                |
| `route.would`                                  | The model the router chose                                                  |
| `route.tier`                                   | The tier the router chose                                                   |
| `route.source`                                 | `pin`, `override`, `escalation`, `rule`, `judge`, `judge-failed`, `default` |
| `route.rule`                                   | The rule id, when a rule decided                                            |
| `route.reason`                                 | Short reason, at most 200 characters                                        |
| `route.caller_model`                           | `input.model`, or the dispatching session's model                           |
| `route.task`, `route.hint_tier`, `route.retry` | From the hint line                                                          |
| `route.judge_ms`                               | Judge latency, when it ran                                                  |
| `route.alert`                                  | `second-failure` on a second failure                                        |

**Metrics** (delta temporality):

| Name                                            | Type      | Attributes                                             |
| ----------------------------------------------- | --------- | ------------------------------------------------------ |
| `model_advisor.decisions`                       | counter   | `agent`, `source`, `mode`, `model`, `would`, `changed` |
| `model_advisor.escalations`                     | counter   | `agent`, `step` (`climb` or `stop`)                    |
| `model_advisor.judge.calls`                     | counter   | `outcome` (`ok`, `timeout`, `error`, `invalid`)        |
| `model_advisor.decision.duration`               | histogram | `agent`, `source`, `mode`; ms, includes the judge      |
| `model_advisor.shadow.estimated_saving_usd`     | counter   | `agent`, `model`, `would`                              |
| `model_advisor.shadow.estimated_extra_cost_usd` | counter   | `agent`, `model`, `would`                              |
| `model_advisor.advisor.calls`                   | counter   | `agent`                                                |
| `model_advisor.advisor.tokens`                  | counter   | `agent`, `kind` (`input`, `output`)                    |
| `model_advisor.advisor.cost_usd`                | counter   | `agent`; advisor tokens at list price, input uncached  |
| `model_advisor.advisor.refusals`                | counter   | `agent`                                                |
| `model_advisor.advisor.would_attach`            | counter   | `agent`; shadow mode                                   |

`changed` is true when the chosen model differs from the caller's: what enforce would change.

The shadow estimate comes from the routed child session's per-step usage. Each step costs
`cost × (1 − price(would) / price(actual))` at list input price (haiku 1, sonnet 3, opus 5 $/Mtok;
output ×5, cache read ×0.1, cache write ×1.25, which cancel in the ratio). When OpenCode reports no
cost (subscription accounts), the step is priced from its tokens at list. A would-model that costs
more goes to `estimated_extra_cost_usd` instead, so both counters only grow.

## Limitations

- Single-process state: escalation remembers tiers per plugin process, not across restarts.
- Several parallel dispatches of the same agent from one session are matched to their child sessions
  in order, so the saving estimate can be attributed to a sibling.
- The saving estimate prices tokens only; it ignores that a cheaper model may need more steps.
- OpenCode 1: routing, spans and metrics work; there is no judge (no one-shot model call for plugins)
  and no saving estimate (no per-step cost events).
- Advising needs opencode-claude-accounts with request hooks; without them nothing is attached.
- The advisor has not been tried with executor thinking enabled, or against the real API accepting a follow-up turn whose earlier advisor blocks were removed; the integration test replays a captured stream. Leave it in shadow mode first.
- Orchestrators never get the advisor here, although the spec lets an orchestrator on a cheaper model have one.
- Coexistence with a plugin that rewrites the model per request (such as `agentModels` in
  opencode-claude-accounts) is not detected; remove routed agents from such settings.

## Development

Tool versions (Node, pnpm, bun) come from `mise.toml`; `mise install` sets them up.

```sh
mise run check              # everything CI runs: lint, typecheck, tests, build, TUI checks, pack
mise run test               # unit tests only
mise run calibrate          # routing v2 calibration from your decisions log (suggestions only)
mise run grafana            # regenerate grafana/model-router.json
pnpm run check:tui          # type-check the TUI (after a build)
pnpm run check:v2           # run the TUI entry against a fake OpenCode 2 context (needs bun)
pnpm run test:tui           # load the TUI in an isolated OpenCode, in a pseudo-terminal
pnpm run test:integration   # the built plugin in an isolated OpenCode, replayed provider
pnpm run smoke:telemetry    # synthetic decisions to an OTLP collector
```

The integration test points `XDG_*` and `HOME` at a temp directory and never touches your
OpenCode configuration.

## License

MIT
