# Calibration

Calibration checks whether the routing policy matches what really happened. It reads the decisions
log and OpenCode's session store, writes `calibration.json`, and suggests config changes. It never
edits your config; you apply changes yourself.

## What it checks

1. **Tasks.** Decisions that carry a task are grouped by task, inside the window (default 30 days).
2. **Per task.**
   - `retries`: the larger of the highest `retry` fact and the number of extra dispatches of any
     one agent.
   - first pass: no retries at all (no agent dispatched twice, no retry fact above zero).
   - cost: the sum of the cost of the child sessions linked to the task's decisions. Unknown when
     the store, the table or the link is missing.
   - risk, difficulty and level come from the task's first dispatch. Difficulty is scored again
     with the **current** config, so a changed rubric shows its effect on old tasks. A log record
     from routing v1 has no facts: risk comes from its tier (`haiku` low, `sonnet` medium, `opus`
     high, or a risk name), `files` and `retry` are used if the record has them, and the level is
     the tier.
3. **Buckets.** Per risk × difficulty × level: tasks, first-pass rate, average retries, cost per
   task.
4. **Backtest.** Per difficulty (`low`, `medium`, `high`): tasks, average retries, cost per task.
   `monotonic` is true when retries and cost do not fall from `low` to `medium` to `high`, looking
   only at difficulties with at least `calibration.minTasks` tasks.

## Output

Written atomically to `$OPENCODE_MODEL_ADVISOR_CALIBRATION`, else
`$XDG_DATA_HOME/opencode/model-advisor/calibration.json` (default `~/.local/share/...`).

```json
{
  "v": 1,
  "t": "2026-06-30T04:15:00.000Z",
  "window_days": 30,
  "tasks": 42,
  "buckets": [
    {
      "risk": "low",
      "difficulty": "low",
      "level": "fast",
      "tasks": 12,
      "firstPass": 0.58,
      "avgRetries": 0.5,
      "costPerTask": 0.21
    }
  ],
  "backtest": {
    "monotonic": true,
    "byDifficulty": {
      "low": { "tasks": 20, "avgRetries": 0.2, "costPerTask": 0.1 },
      "medium": { "tasks": 15, "avgRetries": 0.6, "costPerTask": 0.3 },
      "high": { "tasks": 7, "avgRetries": 1.1, "costPerTask": 0.9 }
    }
  },
  "suggestions": [
    {
      "id": "matrix:low.low.fast",
      "kind": "matrix",
      "path": "v2.policy.matrix.low.low",
      "from": "fast",
      "to": "standard",
      "why": "first-pass 58% over 12 tasks, under 70%"
    }
  ]
}
```

`costPerTask` is `null` when no task in the bucket has a known cost. Rates are fractions (0 to 1).

## Reading suggestions

| kind     | Meaning                                                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matrix` | A bucket with at least `minTasks` tasks has a first-pass rate under `minFirstPass`. Move that matrix cell one level up (`from` to `to`). Skipped when the bucket is already at the top level, or the matrix cell is already above the bucket's level. |
| `cutoff` | A harder difficulty bucket looks easier than the one below it (fewer retries, or lower cost when retries tie). The lower bucket holds tasks that are harder than scored, so lower the upper bucket's cutoff by one point (`medium` not below 1, `high` above `medium`).        |
| `info`   | A level was never chosen in the last 30 days (counted over routing v2 decisions). Nothing to apply; consider removing the level or checking the matrix.                                                                                       |

`path` is the dotted path inside your config file. `minFirstPass` (default 0.7) and `minTasks`
(default 5) live under `v2.calibration`. Treat a suggestion as a prompt to look, not an order: a
small sample or a few unlucky tasks can trip it.

When a run has at least one `matrix` or `cutoff` suggestion it appends one `alert` record
(`alert: "calibration"`) to the decisions log, so the sidebar can show it. `info` alone does not
raise an alert.

## Running

```sh
pnpm calibrate run              # table for the last 30 days
pnpm calibrate run --days 7
pnpm calibrate run --json
```

Every run also writes `calibration.json`.

Inputs:

- Decisions log: the usual decisions file and its rolled `.1` file.
- OpenCode store: `$OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`, opened read-only. Only
  the child sessions found in the log are queried. If the file or the `session_v2` table is
  missing, the run still works and costs are unknown.

## Schedule

```sh
pnpm calibrate install     # daily at 04:15; --hour and --minute change it
pnpm calibrate uninstall
```

On macOS `install` writes a launchd agent `dev.opencode-model-advisor.calibrate` to
`~/Library/LaunchAgents` and loads it. On Linux it prints a crontab line to add with `crontab -e`.
The scheduled command is the same `run`, with output going to `calibrate.log` next to the advisor
log.
