# opencode-model-advisor — spec (draft)

Status: draft, for review before any code.

## Problem

Subagents inherit their parent's model unless something sets one. In practice an Opus
orchestrator turns every worker into Opus, and nothing explains why a dispatch got the model
it got. The fix has two halves that are often confused:

- **Routing** — pick the model that runs a task, once, when it is dispatched.
- **Advising** — let the model running a task consult a stronger one mid-task, when it needs to
  (Anthropic's advisor tool, `advisor_20260301`).

## Roles

Each role has one job. A role never does another's.

| Role | Job | Never does |
| --- | --- | --- |
| Executor | Runs the task: tools, edits, output. Sonnet by default. | Chooses its own model |
| Advisor | Reads the whole transcript, returns a short plan, a correction or "stop". Opus, server-side. | Calls tools, writes user-facing output |
| Router | Picks the executor model for a new dispatch: rules first, judge second. | Changes a model mid-task |
| Judge | Classifies one task into a tier with a reason. Haiku. Runs only when no rule matched. | Names a model outside the configured tiers |
| Escalation | After a reported failure, the task's next dispatch goes one tier up, once. Second failure: stop climbing, alert. | Escalates without a failure signal |
| Operator | Pins, prompt overrides, shadow/enforce switch. | — |
| Observer | Spans, usage log, TUI. Records every decision and every advisor call. Alerts, never blocks. | Decides anything |

Orchestrators (the main session and agents listed as `orchestrators`) are never routed. They
keep their model; if that model is Sonnet they still get the advisor.

## Routing

Order, first match wins:

1. Operator pin for this session or agent (TUI command or config).
2. Prompt override: `[[advisor: opus]]` anywhere in the dispatch prompt (removed before sending).
3. Escalation: a hint says `retry>=1` → one tier above the last dispatch of that task.
4. Rules (config): match on agent name, hint fields, prompt keywords, prompt size.
5. Judge: Haiku reads the first 4000 characters of the prompt and returns `{tier, reason}`.
6. Default tier (`sonnet`).

The router overrides any model the caller passed (operator decision). The decision and its
source (`pin|override|escalation|rule:<id>|judge|default`) are always recorded.

### Hint line (how a caller describes a task)

Optional, one line, anywhere in the dispatch prompt:

```
[[route: task=1047 tier=high retry=1 files=12]]
```

All fields optional. `task` keys escalation; `tier` is the caller's own classification
(`low|medium|high|critical`); `retry` counts failed attempts. Unknown fields are ignored. The
line is stripped before the request leaves.

### Config (`~/.config/opencode/model-advisor.jsonc`)

```jsonc
{
  "mode": "shadow",                       // shadow | enforce
  "tiers": { "haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5" },
  "default": "sonnet",
  "orchestrators": ["build", "plan", "coordinator"],
  "rules": [
    { "id": "critical", "when": { "hint.tier": ["high", "critical"] }, "tier": "opus" },
    { "id": "risky-area", "when": { "prompt": "(?i)\\b(auth|security|migration|secret|crypto)\\b" }, "tier": "opus" },
    { "id": "big", "when": { "hint.files": ">=15" }, "tier": "opus" },
    { "id": "review-security", "when": { "agent": ["reviewer-security", "approver"] }, "tier": "opus" },
    { "id": "read-only", "when": { "agent": ["explore", "investigator"] }, "tier": "sonnet" }
  ],
  "judge": { "enabled": true, "model": "claude-haiku-5-5", "timeoutMs": 8000 },
  "advisor": { "enabled": true, "model": "claude-opus-5-5", "maxUses": 3 }
}
```

## Advising

For every request whose model is below the advisor model and accepts it as an advisor:

- add the `advisor_20260301` tool (`model`, `max_uses`) and the beta header
  `advisor-tool-2026-03-01`;
- append to the system prompt when to consult: before committing to an approach, when an error
  recurs, before declaring the task done;
- if the API refuses the pairing, resend once without the advisor and record it (same as
  Claude Code), so a refusal never fails a turn.

The tool definition is fixed for the session, so it does not invalidate the prompt cache.

## Observability

Span attributes on each dispatch and chat span: `route.model`, `route.source`, `route.rule`,
`route.mode`, `route.would` (shadow), `advisor.attached`, `advisor.calls`,
`advisor.input_tokens`, `advisor.output_tokens`, `advisor.cost_usd`.

Alerts (toast, never blocking):

- a Sonnet executor ran a turn longer than N steps with no advisor attached;
- the advisor was refused for a pairing;
- a task hit its second failure.

## TUI

Sidebar line per session: `executor sonnet · rule:risky-area · advisor 2 calls ($0.04)`.
Commands: pin a model, switch shadow/enforce, show the last 20 decisions with reasons.

## Shadow week

`mode: shadow` routes nothing and attaches no advisor; it records `route.would` beside the model
actually used. After a week the dashboard shows what enforcing would have changed (model mix,
estimated cost). Switch with one config key or the TUI command.

## Coexistence

- **opencode-claude-accounts** `agentModels` rewrites the model per request and would undo the
  router. Routed agents are removed from `agentModels`; the plugin warns at start if an agent
  appears in both.
- **Other routers** (an agent harness that sets `model` on dispatches) stop deciding when this
  plugin is loaded and pass their hints through the hint line instead, so there is one decider.
- **Claude Code**: not in scope; it has `/advisor` and per-subagent `model` natively.

## Example consumer: a ticket-driven agent factory

- The coordinator adds the hint line to every builder/reviewer dispatch: `task` = ticket
  number, `tier` = the ticket's tier label, `retry` = number of failed verdicts or rejected
  reviews for that ticket so far, `files` = planned file count when known.
- The coordinator and approver keep Opus (orchestrator list / rule).
- The factory's usage report reads `route.*` and `advisor.*` from the usage log to show the mix.

## Validation (done before implementation)

Tested with Claude Code 2.1.322 and OpenCode 2.3.0, on a subscription (OAuth) account,
Sonnet 5.5 executor + Opus 5.5 advisor.

| # | Test | Result |
| --- | --- | --- |
| A | Advisor tool accepted on a subscription account (Claude Code `--advisor opus`) | ✅ one `server_tool_use` (`advisor`) + `advisor_tool_result` (`advisor_redacted_result`, encrypted). Fails silently (no tool attached) when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| A | Request shape | `{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}` in `tools` |
| A | Usage reporting | top-level `usage` is the executor only; advisor tokens are only in `usage.iterations[]` (`type: "advisor_message"`, `model`) |
| A | Advisor cost | the advisor read the whole transcript **uncached** (29k input tokens, cache read 0). One consult ≈ context × Opus input price |
| B | OpenCode turn 1 with the raw advisor stream | ✅ answer shown; ⚠️ advisor shown as a failed `advisor` tool ("Provider did not return a tool result"); ⚠️ advisor tokens summed into the executor's (priced as Sonnet) |
| C | OpenCode turn 2 (same session) | ❌ fails before sending: `Anthropic Messages does not know how to round-trip server tool result for advisor` |
| C | Turn 1 + 2 with advisor blocks stripped from the response stream (indexes renumbered, usage executor-only) | ✅ both turns succeed, clean history, correct executor tokens |

Consequences for the design:

1. **Advising requires a response-stream filter**: drop `server_tool_use`(`advisor`) and
   `advisor_tool_result` blocks, renumber block indexes, and remove `advisor_message` entries from
   `usage.iterations` (recording them separately as advisor usage). Without it, every OpenCode
   session breaks on the turn after its first advisor call.
2. **The advisor's advice is not kept in history** (it is encrypted anyway); it only shapes the
   turn it was given in.
3. **Advisor calls are priced by context size**: gate attaching the advisor on context length
   (e.g. under 120k tokens) and keep `maxUses` low.
4. Not yet tested: executor thinking enabled together with an advisor call; the real API
   accepting a follow-up turn whose earlier assistant message had its advisor blocks removed.
   Both go in the shadow week with live requests before enforcing.

## Out of scope

Non-Anthropic providers, Fable, routing mid-task, blocking anything.
