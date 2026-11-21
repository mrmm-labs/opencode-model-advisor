# telemetry Specification

## Purpose

Record every decision locally and optionally export spans and metrics, without ever exporting prompt text.

## Requirements

### Requirement: Decisions log

The plugin SHALL append one line per decision to `decisions.jsonl` next to `advisor.log`, rolling to `.1` past 256 KB, and SHALL store only a one-line credential-filtered task summary (none when `log.summary` is false).

#### Scenario: Summary off

- **WHEN** `log.summary` is false
- **THEN** no task summary is written

### Requirement: OTLP export is opt-in

Export SHALL stay off until `otel.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Spans and metrics SHALL be sent as OTLP/HTTP JSON with no dependencies, batched every two seconds and flushed on shutdown; a failed post SHALL be dropped. Prompt text MUST NOT be exported.

#### Scenario: No endpoint

- **WHEN** no endpoint is configured
- **THEN** nothing is posted

#### Scenario: Collector down

- **WHEN** a post fails
- **THEN** the batch is dropped and routing is unaffected

### Requirement: Decision span

Each decision SHALL produce a span `route <agent>` with the attributes in README Telemetry, and its trace id SHALL be the root session's, computed as opencode-claude-accounts does, so both plugins' spans share a trace.

#### Scenario: One session tree

- **WHEN** both plugins export for one session tree
- **THEN** their spans share one trace id

### Requirement: Metrics

The plugin SHALL export delta-temporality metrics for decisions, escalations, judge calls, decision duration, shadow estimated saving and extra cost, and advisor calls, tokens, cost and refusals.

#### Scenario: Costlier would-model

- **WHEN** the would-model costs more than the actual one
- **THEN** the step is counted in `estimated_extra_cost_usd`, so both saving counters only grow

### Requirement: Saving estimate

The shadow estimate SHALL price each step as `cost x (1 - price(would) / price(actual))` at list input price, from the routed child session's per-step usage, and SHALL price from tokens at list when OpenCode reports no cost.

#### Scenario: Subscription account

- **WHEN** OpenCode reports zero cost
- **THEN** the step is priced from its tokens at list

## Gaps

- The estimate ignores that a cheaper model may need more steps.
- There is no estimate on OpenCode 1 (no per-step cost events).
