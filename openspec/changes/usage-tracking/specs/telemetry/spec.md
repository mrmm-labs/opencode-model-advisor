## ADDED Requirements

### Requirement: Usage metrics

The plugin SHALL export delta counters `model_advisor.usage.requests`, `model_advisor.usage.tokens` (extra attribute `kind`: input, output, reasoning, cache_read, cache_write) and `model_advisor.usage.cost_usd`, each with `model`, `role` (`executor` or `advisor`) and `agent` attributes.

#### Scenario: One advisor call

- **WHEN** an advisor call is recorded
- **THEN** the requests counter grows by 1 with `role=advisor` and the advisor model

#### Scenario: Zero tokens

- **WHEN** a token kind is zero
- **THEN** no point is counted for it
