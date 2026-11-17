# opencode-model-advisor

An OpenCode plugin that chooses the model for each subagent dispatch, and records why.

Subagents inherit their parent's model unless something sets one. An Opus orchestrator turns every
worker into Opus, and nothing says why a dispatch got the model it got. This plugin picks the model
once, when the task is dispatched, from rules you write, an optional Haiku judge and a default. It
starts in **shadow mode**: it records what it would do and changes nothing.

This is step 1 of [the design](docs/spec.md): the router and its telemetry. The advisor tool (a
stronger model consulted mid-task) is not implemented yet.

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
pnpm install && pnpm run build
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
   comparisons; a list means any of.
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

| Key             | Default                        | Meaning                                                           |
| --------------- | ------------------------------ | ----------------------------------------------------------------- |
| `mode`          | `shadow`                       | `shadow` or `enforce`                                             |
| `provider`      | `anthropic`                    | Provider id for tiers that name a bare model id                   |
| `tiers`         | haiku, sonnet, opus (5.5)      | Tier name to model id. Key order is the ladder, cheapest first    |
| `default`       | `sonnet`                       | Tier when nothing else decides                                    |
| `orchestrators` | `build`, `plan`, `coordinator` | Agents that are never routed                                      |
| `pins`          | none                           | Agent name or `session:<id>` to tier                              |
| `rules`         | none                           | `{ id, when, tier }`, see above                                   |
| `judge`         | disabled, haiku, 8000 ms       | `{ enabled, model, timeoutMs }`                                   |
| `otel.endpoint` | env or off                     | OTLP/HTTP base URL; `OTEL_EXPORTER_OTLP_ENDPOINT` is the fallback |

`otel.headers` adds request headers (for an authenticated collector). The log is
`~/.local/share/opencode/model-advisor/advisor.log` (`OPENCODE_MODEL_ADVISOR_LOG` overrides it).

### The judge

On OpenCode 2 the judge is one `ctx.generate.text` call: it goes through OpenCode's own provider and
credentials, and the plugin never reads a key. The reply must name a configured tier, so the judge
cannot pick a model outside your list. The task text is wrapped as data, but it is still text from
your agents: treat the judge as a hint, with rules and pins above it.

It is off by default because every dispatch no rule matched costs one extra short call, and in shadow
mode that is pure overhead until you read the results.

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
- The advisor tool and stream filter from the spec are not built.
- Coexistence with a plugin that rewrites the model per request (such as `agentModels` in
  opencode-claude-accounts) is not detected; remove routed agents from such settings.

## Development

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test
pnpm run test:integration   # the built plugin in an isolated OpenCode, replayed provider
pnpm run smoke:telemetry    # synthetic decisions to an OTLP collector
```

The integration test points `XDG_*` and `HOME` at a temp directory and never touches your
OpenCode configuration.

## License

MIT
