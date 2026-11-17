# Changelog

## Unreleased

### Features

- model router for subagent dispatches: pins, `[[advisor: ...]]` override, escalation after failures, rules, an optional Haiku judge, a default tier
- shadow mode (default) records what would be chosen and changes nothing; enforce mode sets the model and strips the markers
- `[[route: task= tier= retry= files=]]` hint line
- JSONC config at `~/.config/opencode/model-advisor.jsonc`, re-read when it changes
- OpenTelemetry: a `route <agent>` span per decision and `model_advisor.*` metrics, as OTLP/HTTP JSON with no dependencies
- shadow saving estimate from the routed child session's per-step usage (OpenCode 2)
- OpenCode 2 and OpenCode 1 entry points
- TUI: a sidebar line per session, `advisor: mode`, `advisor: pin` and `advisor: decisions` commands, and alert toasts, fed by a bounded `decisions.jsonl` and applied by editing the config file in place
- advisor tool (off by default): attaches `advisor_20260301` to a cheaper executor's requests in enforce mode, filters the advisor's blocks and usage out of the response so OpenCode can round-trip the turn, resends once without it when the API refuses the pairing; hooks into opencode-claude-accounts through a `globalThis` registry
- `advisor` config block, `advisor <agent>` spans, `model_advisor.advisor.*` metrics, sidebar and decisions-list entries, alerts for a refusal and for a long turn with no advisor
- decisions are de-duplicated by tool call id, so a plugin loaded once per project instance records each dispatch once
