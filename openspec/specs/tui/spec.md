# tui Specification

## Purpose

Show in plain words what the router is doing and why, in the OpenCode 2 sidebar and a `/advisor` view.

## Requirements

### Requirement: Loaded as a directory plugin

A `tui.tsx` next to `index.js` SHALL be loaded by OpenCode 2 after a build, since the TUI imports from `dist/`.

#### Scenario: Before a build

- **WHEN** `dist/` does not exist
- **THEN** the TUI cannot load

### Requirement: Compact sidebar

By default the sidebar SHALL show a titled section of at most four rows (`Last task`, `Why`, `Suggested`, `Today`), appended so another plugin may claim the top; `tui.position: "top"` SHALL prepend it. Rows with no data SHALL be left out.

#### Scenario: Shadow title

- **WHEN** mode is `shadow`
- **THEN** the title says `watching only`; in `enforce` it says `choosing models`

#### Scenario: Suggested row

- **WHEN** the router's pick equals the model that ran
- **THEN** the `Suggested` row is omitted

### Requirement: Reason text

`Why` SHALL be the matching rule's `label` if set, else a built-in sentence, or for routing v2 the risk and difficulty.

#### Scenario: Labelled rule

- **WHEN** the deciding rule has a `label`
- **THEN** `Why` shows it

### Requirement: Today figure

`Today` SHALL show the estimated saving since midnight across sessions: `would save` in shadow, `saved` in enforce, `cost ... more` when a net loss; `≈` marks a list-price estimate.

#### Scenario: Net loss

- **WHEN** the day's estimate is negative
- **THEN** the row reads `cost ... more`

### Requirement: Full block

`tui.sidebar: "full"` SHALL show one entry per decision, newest first, at most four, then `+N more`, with a foldable heading.

#### Scenario: Six decisions

- **WHEN** six decisions exist
- **THEN** four are listed plus `+2 more`

## Gaps

- The slash commands (`/advisor` and config editing) are described in README TUI but not enumerated here; check src/commands.ts.
