# routing-v2 Specification

## Purpose

Replace the single-tier lookup with a scored policy: facts describe a dispatch, facts give a difficulty, and a risk by difficulty matrix picks a level that maps to a model.

## Requirements

### Requirement: Off by default

Routing v2 SHALL be disabled unless `v2.enabled` is true, and v1 behaviour SHALL be unchanged while it is off.

#### Scenario: Disabled

- **WHEN** `v2.enabled` is false
- **THEN** v1 rules, judge and default tier decide as before

### Requirement: Order when enabled

With v2 on, the order SHALL be pin, override marker, then v2. v1 rules, the judge and the default tier SHALL NOT be consulted, except that a rule matching on `agent` alone acts as a floor read by tier position.

#### Scenario: Agent-only floor

- **WHEN** a rule matches the agent alone and names the second tier
- **THEN** the level never ends up below the second level

### Requirement: Facts and sources

A dispatch SHALL be described by facts, each keeping its source. The strongest source SHALL win in the order override, connector, caller, plugin, default; for `risk` the highest value from any source SHALL win. Losing values SHALL be stored and a `fact-disagreement` alert recorded.

#### Scenario: Risk disagreement

- **WHEN** a connector says `high` and the caller says `low`
- **THEN** risk is `high` and a `fact-disagreement` alert is recorded

### Requirement: Plugin-derived facts

The plugin SHALL add `promptTokens` (characters divided by 4), `paths` (path-like words, at most 20) and `priorFailures` (only when this process already dispatched the same task). `tier=` SHALL remain an alias of `risk` (T1, T2, T3 as high, medium, low).

#### Scenario: Path facts

- **WHEN** the prompt contains path-like words
- **THEN** up to 20 are stored as facts and the prompt text is not

### Requirement: Policy

After the matrix, the risk floor SHALL lift the level, then each retry SHALL climb `retryStep` levels, capped at the top. An operator override or a connector override level SHALL beat all of it.

#### Scenario: Retry climb

- **WHEN** a task is retried with `retryStep` of 1
- **THEN** the level is one above the matrix result

### Requirement: Config validation

A level name in `matrix`, `riskFloor`, `levelOrder` or `advisor.level` that is not in `levels` SHALL be refused with a warning, and if the policy would point at a missing level v2 SHALL stay off. `levelOrder` SHALL default to the key order of `levels`.

#### Scenario: Unknown level

- **WHEN** `matrix` names a level absent from `levels`
- **THEN** the entry is refused with a warning

### Requirement: Decision record

The decision record SHALL carry the facts with sources, the score breakdown, each policy step and the connector outcomes.

#### Scenario: Decision logged

- **WHEN** v2 decides
- **THEN** `decisions.jsonl` holds a `v2` object with those parts

## Gaps

- The exact difficulty scoring rubric and default matrix live in docs/spec-routing-v2.md and are not restated here.
