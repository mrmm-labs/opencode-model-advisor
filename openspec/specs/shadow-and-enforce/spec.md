# shadow-and-enforce Specification

## Purpose

Let the operator observe routing decisions before letting them change anything, and reload configuration without a restart.

## Requirements

### Requirement: Shadow is the default

`mode` SHALL default to `shadow`: the plugin records the model it would choose (`route.would`) beside the model actually used and changes nothing.

#### Scenario: No config file

- **WHEN** no config file exists
- **THEN** the plugin runs in shadow mode with no rules and no judge and records every dispatch under the default tier

### Requirement: Enforce

In `enforce` mode the plugin SHALL set the subagent's model, only when it differs from the caller's, and strip the markers from the prompt.

#### Scenario: Differing model

- **WHEN** mode is `enforce` and the chosen model differs from the caller's
- **THEN** the dispatch uses the chosen model

#### Scenario: Same model

- **WHEN** the chosen model equals the caller's
- **THEN** nothing is set

### Requirement: Hot reload

The config SHALL be re-read when its modification time changes. Invalid parts SHALL fall back to defaults and log a warning.

#### Scenario: Edited

- **WHEN** the config file is saved while OpenCode runs
- **THEN** the next decision uses the new config without a restart

### Requirement: Config location

The config SHALL be read from `~/.config/opencode/model-advisor.jsonc` (JSONC) or the path in `OPENCODE_MODEL_ADVISOR_CONFIG`.

#### Scenario: Env override

- **WHEN** `OPENCODE_MODEL_ADVISOR_CONFIG` is set
- **THEN** that file is used

## Gaps

- Coexistence with plugins that rewrite the model per request (for example `agentModels` in opencode-claude-accounts) is not detected.
