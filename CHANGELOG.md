# Changelog

## [0.5.0](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.4.0...v0.5.0) (2026-11-20)


### ⚠ BREAKING CHANGES

* **tui:** /advisor-mode, -pin, -decisions, -alert, -check, -settings and -calibration are gone. Use /advisor mode <mode> (it no longer toggles), pin <target> <tier>, unpin <target>, decisions, alert, check <input...>, settings <section>, calibration <item>. The palette entries are now one per sub-command.

### Features

* **tui:** one /advisor command with a sub-command picker ([#23](https://github.com/mrmm-labs/opencode-model-advisor/issues/23)) ([977378e](https://github.com/mrmm-labs/opencode-model-advisor/commit/977378ee1259b11dbfa9b7d3b9efbdb34084d7fb))

## [0.4.0](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.3.0...v0.4.0) (2026-11-20)


### Features

* **tui:** readable alert toasts that open the session ([#21](https://github.com/mrmm-labs/opencode-model-advisor/issues/21)) ([aa51ef1](https://github.com/mrmm-labs/opencode-model-advisor/commit/aa51ef1404ce3ec346c47a1ad3332b4f9214d451))

## [0.3.0](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.2.0...v0.3.0) (2026-11-20)


### Features

* **tui:** plain-words compact sidebar ([#19](https://github.com/mrmm-labs/opencode-model-advisor/issues/19)) ([bf604ef](https://github.com/mrmm-labs/opencode-model-advisor/commit/bf604ef6ffb04b372095e781e93ba43cf42bd8a5))

## [0.2.0](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.5...v0.2.0) (2026-11-20)


### Features

* **tui:** compact sidebar section, detail moves to an /advisor dialog ([#17](https://github.com/mrmm-labs/opencode-model-advisor/issues/17)) ([2b14446](https://github.com/mrmm-labs/opencode-model-advisor/commit/2b14446c507c1b135477727e001331ce83d7d7c9))

## [0.1.5](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.4...v0.1.5) (2026-11-18)


### Bug Fixes

* **otel:** drop null and non-finite attributes, which made the collector reject whole batches ([#15](https://github.com/mrmm-labs/opencode-model-advisor/issues/15)) ([4005a70](https://github.com/mrmm-labs/opencode-model-advisor/commit/4005a70de6e0f1c99862dd9d45df4e0edf632fff))

## [0.1.4](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.3...v0.1.4) (2026-11-18)


### Bug Fixes

* **test:** tests never read the user config or calibration file ([#13](https://github.com/mrmm-labs/opencode-model-advisor/issues/13)) ([3152f7c](https://github.com/mrmm-labs/opencode-model-advisor/commit/3152f7cf74adc5bcea5aef91f4f6db05c1cc284d))

## [0.1.3](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.2...v0.1.3) (2026-11-18)


### Bug Fixes

* **calibrate:** count only re-dispatches of retryAgents (default builder) as retries ([#11](https://github.com/mrmm-labs/opencode-model-advisor/issues/11)) ([0b7592e](https://github.com/mrmm-labs/opencode-model-advisor/commit/0b7592e48f40eccf919e4da70fd9350107a8b393))

## [0.1.2](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.1...v0.1.2) (2026-11-18)


### Bug Fixes

* timestamps use the wall clock, which keeps running while the machine sleeps ([#9](https://github.com/mrmm-labs/opencode-model-advisor/issues/9)) ([dc4dbd8](https://github.com/mrmm-labs/opencode-model-advisor/commit/dc4dbd8a3a5e95d577c2bcb6d161ae4baf89e295))

## [0.1.1](https://github.com/mrmm-labs/opencode-model-advisor/compare/v0.1.0...v0.1.1) (2026-11-18)


### Bug Fixes

* register the advisor tool only when routing v2 is on ([#6](https://github.com/mrmm-labs/opencode-model-advisor/issues/6)) ([35a22f9](https://github.com/mrmm-labs/opencode-model-advisor/commit/35a22f91c8998c812079d77e971392b96064e255))

## 0.1.0 (2026-11-18)


### Features

* add a TUI with a sidebar line, mode and pin commands, a decisions list and alert toasts ([3545009](https://github.com/mrmm-labs/opencode-model-advisor/commit/3545009afa8ea35e41782cd382abf63367b5f101))
* add the advisor tool and the response filter that lets OpenCode round-trip it ([2cf50b1](https://github.com/mrmm-labs/opencode-model-advisor/commit/2cf50b1e660e069256d33849cdae79142056be00))
* route subagent dispatches in shadow or enforce mode ([4beb486](https://github.com/mrmm-labs/opencode-model-advisor/commit/4beb486a2c58dd5a3cd3e7145f5c061178beb5f6))
* routing v2 (facts, connectors, difficulty score, levels, calibration, TUI, telemetry, any-provider advisor) ([#4](https://github.com/mrmm-labs/opencode-model-advisor/issues/4)) ([068281c](https://github.com/mrmm-labs/opencode-model-advisor/commit/068281ceea244ca03a889ed51c6d7b3c9dbb9177))
* structured sidebar panel, top or bottom, and a grouped decisions list ([f5a0b47](https://github.com/mrmm-labs/opencode-model-advisor/commit/f5a0b47a6eecb50b5d4f120ffa0645e485d47576))


### Bug Fixes

* keep sub-millisecond span timing and keep tests off the real log ([e7650a6](https://github.com/mrmm-labs/opencode-model-advisor/commit/e7650a6b68d8963dbb8e341f3a1e4a757556cbb7))

## Changelog

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
