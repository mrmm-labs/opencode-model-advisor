# usage-tracking Specification

## Purpose

Record what each executor step and advisor call used and cost, per model, agent and day, and show it as a report, a sidebar line and metrics.

## Requirements

### Requirement: Executor usage rows

The plugin SHALL append one usage row per finished or failed executor step with the provider and model, agent and session of the step, tokens (input, output, reasoning, cache read, cache write) and cost. When the host reports no cost the row SHALL be priced at list price from its tokens and marked estimated.

#### Scenario: Step ended

- **WHEN** a `session.step.started` for a message is followed by `session.step.ended` for it
- **THEN** one executor row has the started model and agent and the ended tokens and cost

#### Scenario: Subscription account

- **WHEN** the step reports zero cost
- **THEN** the row's cost is the list price of its tokens and it is marked estimated

#### Scenario: Failed step without tokens

- **WHEN** `session.step.failed` carries no tokens
- **THEN** no row is written

### Requirement: Advisor usage rows

The plugin SHALL append one usage row per advisor call, with the advisor model, tokens and list-price cost, taken from the `advisor_message` entries of `usage.iterations` before they are stripped, and from the plugin `advisor` tool.

#### Scenario: Two advisor calls in one response

- **WHEN** a response carries two `advisor_message` iterations
- **THEN** two advisor rows are written, each with its own model and tokens

#### Scenario: Executor tokens exclude the advisor

- **WHEN** a response carried advisor iterations
- **THEN** the executor row for the step counts none of the advisor's tokens

### Requirement: Local usage store

Rows SHALL be appended to `usage.jsonl` next to `advisor.log` (path overridable with `OPENCODE_MODEL_ADVISOR_USAGE`). Past 2 MB the file SHALL be folded into aggregates by day, provider, model, agent and role that keep the request count, tokens, cost and session ids. Writing MUST NOT throw.

#### Scenario: Folding

- **WHEN** the file passes 2 MB
- **THEN** rows of the same day, provider, model, agent and role become one row whose totals equal the sum

#### Scenario: Unwritable path

- **WHEN** the file cannot be written
- **THEN** the plugin carries on

### Requirement: Usage report

`/advisor usage [today|7d|30d]` (default `today`; `7d` and `30d` include today) SHALL show a table of model, role, requests, tokens and cost, the totals, the advisor's share of the total cost, the shadow estimate (would save, not applied) beside the applied saving, and a points line that says `points: n/a`.

#### Scenario: Advisor share

- **WHEN** the window has executor cost 3.10 and advisor cost 0.40
- **THEN** the advisor's share reads 11%

#### Scenario: No usage

- **WHEN** the window has no rows
- **THEN** the report says there is no usage yet

#### Scenario: Estimated cost

- **WHEN** any row in the window is estimated
- **THEN** the report says those costs are list-price estimates
