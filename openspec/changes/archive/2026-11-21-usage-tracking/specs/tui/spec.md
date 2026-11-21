## MODIFIED Requirements

### Requirement: Compact sidebar

By default the sidebar SHALL show a titled section of at most five rows (`Last task`, `Why`, `Suggested`, `Today`, `Saving`), appended so another plugin may claim the top; `tui.position: "top"` SHALL prepend it. Rows with no data SHALL be left out. `Today` SHALL be today's spend, `<model> $x · advisor $y`, and SHALL show even when the session has no decision.

#### Scenario: Shadow title

- **WHEN** mode is `shadow`
- **THEN** the title says `watching only`; in `enforce` it says `choosing models`

#### Scenario: Suggested row

- **WHEN** the router's pick equals the model that ran
- **THEN** the `Suggested` row is omitted

#### Scenario: Spend row

- **WHEN** today's usage has executor cost on one model and advisor cost
- **THEN** `Today` reads like `opus $3.10 · advisor $0.40`, shortened to fit the sidebar width

#### Scenario: No decision yet

- **WHEN** the session has no decision but today has usage
- **THEN** the section shows the `Today` row alone

## REMOVED Requirements

### Requirement: Today figure

**Reason**: The `Today` label now names spend; the saving figure is the `Saving` requirement.
**Migration**: Read the saving on the `Saving` row.

## ADDED Requirements

### Requirement: Saving figure

`Saving` SHALL show the estimated saving since midnight across sessions: `would save` in shadow, `saved` in enforce, `cost ... more` when a net loss; `≈` marks a list-price estimate.

#### Scenario: Net loss

- **WHEN** the day's estimate is negative
- **THEN** the row reads `cost ... more`

### Requirement: Usage command

`/advisor usage [window]` and `/advisor-usage [window]` SHALL open the usage report; `window` is `today`, `7d` or `30d` and defaults to `today`.

#### Scenario: Default window

- **WHEN** `/advisor-usage` is run with no argument
- **THEN** the report covers today
