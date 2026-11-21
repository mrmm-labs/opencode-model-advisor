# judge Specification

## Purpose

Classify a task into a tier when no rule matched, using a cheap model, without the plugin ever holding credentials.

## Requirements

### Requirement: Off by default

The judge SHALL be disabled by default, because each unmatched dispatch costs one extra short call.

#### Scenario: Not configured

- **WHEN** `judge.enabled` is not set
- **THEN** no judge call is made

### Requirement: Runs only when no rule matched

The judge SHALL run only after pin, override, escalation and rules produced no decision, and SHALL read the first 4000 characters of the prompt.

#### Scenario: Rule matched

- **WHEN** a rule matched
- **THEN** the judge is not called

### Requirement: Answer constrained to configured tiers

The judge's reply SHALL name a configured tier; any other reply SHALL be treated as invalid.

#### Scenario: Unknown tier

- **WHEN** the judge answers with a tier not in `tiers`
- **THEN** the default tier is chosen with source `judge-failed`

### Requirement: Failure falls back

Any judge failure (timeout, error, invalid reply) SHALL give the default tier with source `judge-failed`.

#### Scenario: Timeout

- **WHEN** the call exceeds `timeoutMs`
- **THEN** the default tier is used and the outcome is counted as `timeout`

### Requirement: Uses OpenCode's provider

On OpenCode 2 the judge SHALL go through `ctx.generate.text` and the plugin MUST NOT read an API key.

#### Scenario: OpenCode 1

- **WHEN** the host has no one-shot model call for plugins
- **THEN** there is no judge

### Requirement: Works in shadow mode

The judge SHALL still call in shadow mode so `would` is accurate.

#### Scenario: Shadow

- **WHEN** mode is `shadow` and the judge is enabled
- **THEN** the call is made and recorded as `would`

### Requirement: Task text is data

The task text SHALL be wrapped as data in the judge prompt.

#### Scenario: Injection attempt

- **WHEN** the task text asks the judge to ignore its instructions
- **THEN** the reply is still validated against the configured tiers

## Gaps

- Wrapping reduces but does not remove prompt injection; the README says to treat the judge as a hint below rules and pins.
