# advisor-tool Specification

## Purpose

Let a cheaper executor consult a stronger model mid-task through Anthropic's advisor tool, off by default, without breaking OpenCode's turn round-trip.

## Requirements

### Requirement: Opt-in attach conditions

A request SHALL get the advisor tool only when advising is enabled and mode is `enforce`, the executor is below the advisor model on the tier ladder, the agent is set and not an orchestrator, the request is not a judge call, the estimated context is under `maxContextTokens` (body length divided by 4), and the API has not already refused this pair in this process.

#### Scenario: Shadow mode

- **WHEN** mode is `shadow`
- **THEN** nothing is attached and the first request of each session records `advisor.would_attach`

#### Scenario: Context too large

- **WHEN** the estimated context exceeds `maxContextTokens`
- **THEN** the tool is left off from then on in that session

### Requirement: What is attached

Attaching SHALL add the tool with `max_uses` set to `maxUses`, merge `advisor-tool-2026-03-01` into `anthropic-beta`, and append one fixed line to the last system text block. The definition and line SHALL be identical on every request so the prompt cache is not invalidated.

#### Scenario: Two requests

- **WHEN** two requests of a session both get the advisor
- **THEN** the tool definition and system line are byte-identical

### Requirement: Response filter

Every response to a request the plugin attached the advisor to SHALL be filtered: `advisor` `server_tool_use` and `advisor_tool_result` blocks dropped, remaining block indexes renumbered, and `advisor_message` entries removed from `usage.iterations`. Everything else SHALL pass through byte for byte, chunk by chunk.

#### Scenario: Advisor called

- **WHEN** the executor calls the advisor
- **THEN** the next turn does not fail with a server tool result round-trip error

### Requirement: Refused pairing

A 400 naming the advisor, the tool type or the beta SHALL be resent once without the tool, header value and system line, the pair SHALL be left alone for the rest of the process, and an alert SHALL be raised.

#### Scenario: Refusal

- **WHEN** the API refuses the executor and advisor pair
- **THEN** the turn succeeds on the retry and the pair is not attached again

### Requirement: Hook registry

Advising SHALL run as hooks on the request path of opencode-claude-accounts through a registry on `globalThis`, registered once per process. If nothing calls the hooks, advising SHALL NOT happen and the log SHALL get one `advisor_hooks_idle` line a minute after start.

#### Scenario: No host plugin

- **WHEN** opencode-claude-accounts is not loaded
- **THEN** no tool is attached and `advisor_hooks_idle` is logged

## Gaps

- Not tried with executor thinking enabled, nor against the real API accepting a follow-up turn whose earlier advisor blocks were removed; the integration test replays a captured stream.
- Orchestrators never get the advisor here, although docs/spec.md allows it.
