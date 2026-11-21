# calibration Specification

## Purpose

Check whether the routing policy matches what happened, and suggest config changes without ever editing the config.

## Requirements

### Requirement: Read-only suggestions

Calibration SHALL read the decisions log and OpenCode's session store and SHALL NOT edit the operator's config.

#### Scenario: Run

- **WHEN** `pnpm calibrate run` completes
- **THEN** the config file is unchanged and `calibration.json` is written atomically

### Requirement: Per-task analysis

Decisions carrying a task SHALL be grouped by task inside the window (default 30 days), with retries, first-pass, cost, and risk, difficulty and level from the first dispatch. Difficulty SHALL be rescored with the current config.

#### Scenario: Changed rubric

- **WHEN** the difficulty rubric changed since the decisions were logged
- **THEN** old tasks show their difficulty under the current rubric

### Requirement: Buckets and backtest

It SHALL report per risk, difficulty and level: tasks, first-pass rate, average retries and cost per task, and per difficulty a `monotonic` flag computed only over difficulties with at least `calibration.minTasks` tasks.

#### Scenario: Thin data

- **WHEN** a difficulty has fewer than `calibration.minTasks` tasks
- **THEN** it is ignored for `monotonic`

### Requirement: Degrades without the store

When the OpenCode store or its `session_v2` table is missing, the run SHALL still work with costs unknown. The store SHALL be opened read-only.

#### Scenario: No database

- **WHEN** the database file does not exist
- **THEN** the report is produced with unknown costs

### Requirement: Scheduling

`pnpm calibrate install` SHALL schedule a daily run (default 04:15): a launchd agent on macOS, a printed crontab line on Linux.

#### Scenario: Linux

- **WHEN** `install` runs on Linux
- **THEN** a crontab line is printed and nothing is installed

## Gaps

- v1 log records carry no facts; their risk is derived from the tier, which is an approximation.
