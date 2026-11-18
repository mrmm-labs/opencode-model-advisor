# Routing v2: facts, connectors, levels — spec (approved design, not built)

Status: design approved; implementation in phases below. Extends `docs/spec.md`; where the two
disagree, this file wins.

## Why

v1 routes on one caller-supplied `tier`. Two problems:

1. **Risk is not difficulty.** A risk label says what a mistake costs. It does not say whether a
   cheaper model will get the task right. Production routers (RouteLLM, Cursor Router, Copilot
   Auto) route on difficulty, the chance the cheaper model succeeds, and handle risk as policy.
2. **A copied grade can be wrong.** When an orchestrating model copies a label into the hint line,
   nothing checks it.

## Model

```
facts (caller + plugin + connectors + override)
  → resolve (precedence, highest risk wins)
  → difficulty score (deterministic rubric)
  → policy (risk × difficulty → level, risk floor, retry step-up, agent rules)
  → level → model (any provider)
  → advisor (level-based, any provider)
```

Every step is recorded in the decision.

## 1. Facts

A dispatch is described by facts, never by a grade. Each resolved fact keeps
`{value, source, others: [{value, source}]}`.

| Fact | Values | Typical source |
| --- | --- | --- |
| `risk` | low, medium, high, critical | connector (issue label), caller |
| `files`, `modules` | integers | caller |
| `kind` | new, edit, refactor, migration, delete | caller, connector |
| `migration` | bool | caller, connector |
| `unknowns` | integer (open questions) | caller |
| `retry` | integer | caller, plugin (earlier failed dispatches of the task) |
| `priorFailures` | integer | plugin |
| `promptTokens`, `paths` | integer, globs | plugin |
| `task` | string | caller (keys connectors, escalation, cache) |

Hint line carries facts: `[[route: task=1047 risk=high files=12 modules=3 kind=edit unknowns=2]]`.
`tier=` stays accepted as an alias of `risk`. Unknown keys are ignored. Missing facts take the
config default.

## 2. Sources and conflicts

Precedence, highest first: **override** (operator pin, `[[advisor: …]]`, an override label from a
connector) > **connector** > **caller** > **plugin-derived** > **default**.

Exception: for `risk` the highest value from any source wins.

Every disagreement is stored on the decision and raises a non-blocking alert.

## 3. Connectors

Generic, config-only; the plugin code knows no tracker.

```jsonc
"connectors": [
  {
    "id": "github",
    "match": { "task": "^\\d+$" },
    "command": ["gh", "issue", "view", "{task}", "--json", "labels,title"],
    "timeoutMs": 3000,
    "ttlMinutes": 360,
    "map": [
      { "label": "^tier:T1$", "set": { "risk": "high" } },
      { "label": "^tier:T2$", "set": { "risk": "medium" } },
      { "label": "^tier:T3$", "set": { "risk": "low" } },
      { "label": "^kind:migration$", "set": { "kind": "migration", "migration": true } },
      { "label": "^route:frontier$", "override": { "level": "frontier" } }
    ]
  },
  { "id": "linear", "match": { "task": "^[A-Z]+-\\d+$" }, "http": { "…": "…" }, "map": [] }
]
```

- Connectors **add** facts; they never remove another source's fact.
- Results are cached per task (`ttlMinutes`); a timeout or error is skipped and recorded.
- At most one connector call per task per TTL; the dispatch never waits longer than `timeoutMs`.

## 4. Difficulty score

Deterministic rubric from config, so the same facts always give the same score:

```jsonc
"difficulty": {
  "points": [
    { "fact": "files", "gte": 15, "add": 2 },
    { "fact": "modules", "gte": 3, "add": 2 },
    { "fact": "migration", "eq": true, "add": 2 },
    { "fact": "kind", "in": ["new", "refactor"], "add": 1 },
    { "fact": "unknowns", "per": 1, "add": 1, "max": 3 },
    { "fact": "priorFailures", "per": 1, "add": 2 },
    { "fact": "promptTokens", "gte": 60000, "add": 1 }
  ],
  "cutoffs": { "medium": 2, "high": 4 }
}
```

The decision stores the breakdown: `score 5 = files+2 migration+2 unknowns+1 → high`.

## 5. Policy and levels

```jsonc
"levels": {
  "fast":     { "model": "anthropic/claude-haiku-5-5" },
  "standard": { "model": "anthropic/claude-sonnet-5-5" },
  "frontier": { "model": "anthropic/claude-opus-5-5" }
},
"policy": {
  "matrix": {
    "low":      { "low": "fast",     "medium": "standard", "high": "frontier" },
    "medium":   { "low": "standard", "medium": "standard", "high": "frontier" },
    "high":     { "low": "frontier", "medium": "frontier", "high": "frontier" },
    "critical": { "low": "frontier", "medium": "frontier", "high": "frontier" }
  },
  "riskFloor": { "high": "frontier", "critical": "frontier" },
  "retryStep": 1
}
```

- Order: pin/override → agent rules → matrix (risk × difficulty) → risk floor → retry step-up.
- Levels map to any OpenCode provider/model, so one config can mix providers.
- Orchestrators are still never routed.

## 6. Advisor

The advisor is a level (default `frontier`), attached when the executor's level is below it.

| Executor provider | Implementation |
| --- | --- |
| Anthropic, valid pairing | native `advisor_20260301` server tool (v1 stream filter) |
| any other, or invalid pairing | plugin tool `advisor`: the plugin sends a bounded transcript excerpt to the advisor level's model through OpenCode and returns the plan |

- Config: `advisor.level`, `advisor.impl: auto|native|tool`, `maxUses`, `maxContextTokens`.
- Recorded per subagent: attached, calls, tokens, cost. The tool definition costs prompt tokens even
  when unused, so a low call rate is reported as a candidate for turning the advisor off for that
  agent.

## 7. Calibration (automatic checks, manual changes)

`model-advisor calibrate`, scheduled daily, reads the decision log and OpenCode's session store:

1. **Backtest:** re-scores every past task with the current rubric; checks that higher difficulty
   buckets really have more retries, review rounds and cost.
2. **Calibration table:** per risk × difficulty × level: tasks, first-pass rate, retries, cost per
   finished task.
3. **Suggestions:** when a bucket is out of line (e.g. `low` retries more than `high`, a `standard`
   first-pass rate below the configured floor), it writes a suggested cutoff/weight change and
   raises an alert. It never edits the config; the operator applies changes.

## 8. Observability, TUI, dashboard

- **OTel (optional, `otel.enabled`):** span attributes `route.fact.<name>`,
  `route.fact.<name>.source`, `route.score`, `route.score.breakdown`, `route.level`,
  `route.disagreements`, `connector.<id>.ms|error`; metrics for decisions by level, score
  histogram, disagreements, connector latency/errors, advisor calls and cost, calibration gauges
  per bucket.
- **TUI:** decision detail shows each fact with its source and the losing values, the score
  breakdown, the level and model. A settings dialog per section (connectors, difficulty, policy,
  levels, advisor, calibration) to view and edit config, validated before save. A **check**
  command dry-runs a hint line or task id: facts, sources, score, level, model, without
  dispatching; and a connector test.
- **Grafana:** a dashboard JSON shipped in this repo (Prometheus datasource): level mix, score
  distribution, disagreements, connector health, advisor use, calibration table.

## Phases

1. Facts, resolution, rubric, policy, levels; decision record; tests; shadow.
2. Connectors (command + http), cache, GitHub/Linear examples.
3. TUI: decision detail, check command, section editors.
4. Calibration command + schedule + alerts.
5. OTel attributes/metrics + Grafana dashboard.
6. Provider-agnostic advisor tool.

Each phase ships in shadow mode; enforce stays an operator switch.
