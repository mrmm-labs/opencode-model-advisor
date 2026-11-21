# connectors Specification

## Purpose

Turn labels from an outside system into routing facts, configured entirely in config with no tracker code in the plugin.

## Requirements

### Requirement: Connectors add facts only

A connector SHALL add facts and MUST NOT remove or edit a fact another source gave. A failure SHALL NOT block a dispatch: it is skipped and recorded.

#### Scenario: Connector error

- **WHEN** a connector call fails
- **THEN** the dispatch proceeds and the failure is recorded

### Requirement: Sources

A connector SHALL use exactly one of `command` (an argv array run without a shell) or `http`, and MUST have `timeoutMs` of at most 10000 (default 3000). The call SHALL be killed or abandoned at the limit.

#### Scenario: Slow command

- **WHEN** the command exceeds `timeoutMs`
- **THEN** it is killed and the dispatch is not delayed further

### Requirement: Matching

A connector SHALL run only when its `match.task` and `match.agent` regexes match; an omitted key matches everything.

#### Scenario: Task mismatch

- **WHEN** the task id does not match `match.task`
- **THEN** the connector is not run

### Requirement: Map rules

Each `map` rule's `label` regex SHALL be tested case-insensitively on every label. `set` SHALL add one fact per key with `source` and `detail`; `override.level` SHALL pin the level, the first rule winning.

#### Scenario: Override label

- **WHEN** a label matches a rule with `override.level`
- **THEN** that level is pinned

### Requirement: Task id safety

The task id MUST match `^[A-Za-z0-9._#/-]{1,64}$`; otherwise the connector SHALL be skipped with `bad task id` and nothing run or sent. `{task}` SHALL be substituted only after that check.

#### Scenario: Hostile id

- **WHEN** the task id contains shell metacharacters
- **THEN** the connector is skipped and no process starts

### Requirement: Secrets

Header values MAY use `${ENV_NAME}`; a missing variable SHALL be an error, and header values SHALL never be logged or returned.

#### Scenario: Missing variable

- **WHEN** a header references an unset variable
- **THEN** the connector errors without sending the request

### Requirement: Caching and concurrency

Good results SHALL be cached per task for `ttlMinutes` and errors for 1 minute; at most one call per connector and task is in flight, and at most 50 tasks are cached per connector.

#### Scenario: Repeat dispatch

- **WHEN** the same task is dispatched twice within the TTL
- **THEN** the second dispatch uses the cached result
