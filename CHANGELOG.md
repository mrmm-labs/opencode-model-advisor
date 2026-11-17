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
