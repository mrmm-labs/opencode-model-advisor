# routing Specification

## Purpose

Choose the model for a new subagent dispatch once, from an ordered set of sources, and record the source of the choice.

## Requirements

### Requirement: Decision order

The router SHALL pick the first match in this order: pin, override marker, escalation, rules, judge, default tier.

#### Scenario: Pin beats everything

- **WHEN** an agent is pinned and its prompt also contains an override marker
- **THEN** the pin's tier is chosen

#### Scenario: Default

- **WHEN** no pin, marker, escalation, rule or judge result applies
- **THEN** the `default` tier is chosen with source `default`

### Requirement: Pins

Config `pins` SHALL map an agent name or `session:<id>` (the dispatching session) to a tier.

#### Scenario: Session pin

- **WHEN** the dispatching session has a pin
- **THEN** that tier is chosen

### Requirement: Override marker

A marker `[[advisor: <tier-or-model-fragment>]]` anywhere in the prompt SHALL select that tier or model, and SHALL be stripped from the prompt in enforce mode.

#### Scenario: Marker

- **WHEN** the prompt contains `[[advisor: opus]]`
- **THEN** the opus tier is chosen with source `override`

### Requirement: Hint line

A one-line hint `[[route: task=.. tier=.. retry=.. files=..]]` MAY describe the task; unknown fields SHALL be ignored.

#### Scenario: Unknown field

- **WHEN** the hint carries a field the plugin does not know
- **THEN** the field is ignored and the others apply

### Requirement: Escalation

When the hint says `retry>=1`, the router SHALL choose one tier above the tier last chosen for that task in this process (or above the rule result when the task is new). At `retry>=2` it SHALL keep the tier and raise an alert.

#### Scenario: First retry

- **WHEN** a task previously ran on sonnet and the hint says retry=1
- **THEN** the opus tier is chosen

#### Scenario: Second retry

- **WHEN** the hint says retry=2
- **THEN** the tier does not climb further and a `second-failure` alert is raised

### Requirement: Rules

Rules SHALL be evaluated in config order and MAY match on `agent`, `prompt` (regex), `prompt.length`, `hint.task`, `hint.tier`, `hint.retry` and `hint.files`. Numeric fields SHALL accept comparisons such as `">=15"`; a list SHALL mean any of. A rule MAY carry a `label` used as the sidebar reason.

#### Scenario: Numeric match

- **WHEN** a rule has `hint.files: ">=15"` and the hint says files=20
- **THEN** the rule matches

### Requirement: Never routed

Orchestrators (the `orchestrators` list) and dispatches with no agent SHALL NOT be routed, and continuing an existing child session SHALL NOT be re-routed.

#### Scenario: Orchestrator

- **WHEN** an agent listed in `orchestrators` dispatches
- **THEN** its model is untouched

### Requirement: Tier ladder

The key order of `tiers` SHALL be the ladder, cheapest first.

#### Scenario: Climb

- **WHEN** escalation climbs from the cheapest tier
- **THEN** it moves to the next key in `tiers`

## Gaps

- Escalation state is per plugin process and lost on restart (README Limitations).
- Parallel dispatches of one agent from one session are matched to child sessions in order, which can misattribute a saving estimate.
