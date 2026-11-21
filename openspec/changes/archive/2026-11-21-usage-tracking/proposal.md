## Why

The plugin shows what the advisor consulted and what a different model would have saved, but not what was spent: which model ran each request, what each advisor call cost, and how the two compare over days. Operators cannot tell whether the advisor pays for itself.

## What Changes

- Record one usage row per executor step (model, agent, session, tokens in/out/reasoning/cache read/cache write, cost) from `session.step.ended` / `session.step.failed`, with the model and agent taken from `session.step.started`.
- Record one usage row per advisor call (advisor model, tokens, cost) from the `advisor_message` entries of `usage.iterations`, captured before the stream filter strips them, and from the plugin `advisor` tool.
- Keep a local `usage.jsonl` next to `advisor.log`: raw rows, folded into day x provider x model x agent x role aggregates (with session ids) past 2 MB.
- Add `/advisor usage [today|7d|30d]` and `/advisor-usage`: a table of model, role, requests, tokens and cost, totals, the advisor's share of cost, and the shadow "would save" next to the actual spend.
- Add a sidebar row `Today  opus $3.10 · advisor $0.40`. The existing saving row is renamed `Saving`. **BREAKING** (label only).
- Export OTel counters `model_advisor.usage.requests`, `.tokens` and `.cost_usd` with `model`, `role` and `agent` attributes.
- Weekly-quota points are not derivable by the plugin: output says `points: n/a`.

## Capabilities

### New Capabilities

- `usage-tracking`: per-request usage accounting for executor and advisor models, its local store and the usage report.

### Modified Capabilities

- `tui`: sidebar `Today` row is spend; the saving row is `Saving`; the `usage` sub-command.
- `telemetry`: usage counters.

## Impact

- New `src/usage.ts`; changes in `src/advisor.ts`, `src/advise.ts`, `src/advisor-tool.ts`, `src/stream-filter.ts`, `src/wire.ts`, `src/view.ts`, `src/commands.ts`, `tui/advisor-tui.tsx`.
- No new dependency, no config key. Defaults: always on, read-only accounting. Env `OPENCODE_MODEL_ADVISOR_USAGE` overrides the file path.
- Shadow mode: identical to enforce; nothing here changes a model or attaches a tool. Enforce mode: same rows; `saving` is what the applied pick saved.
- Out of scope: OpenCode 1 executor usage (no step events; advisor rows only), title and compaction usage (`session.usage.recorded`), weekly-quota points, budgets and alerts, per-account split.
