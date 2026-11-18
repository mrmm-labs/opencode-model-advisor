# Connectors

A connector looks up a task in an outside system (an issue tracker, a ticket API, a script) and
turns its labels into routing facts. The plugin code knows no tracker: a connector is config only.
See `docs/spec-routing-v2.md` for the routing model.

## What a connector does

- It **adds** facts. It never removes or edits a fact another source gave.
- Precedence, highest first: override > connector > caller > plugin-derived > default.
  A connector's `override` label (for example `route:frontier`) is an operator-level pin.
- Exception: for `risk` the highest value from any source wins. A connector that says `high`
  beats a caller that says `low`, and a caller's `critical` beats a connector's `high`.
- Every disagreement between sources is stored on the decision and raises a non-blocking alert.
- Results are cached per task. A failure never blocks a dispatch: it is skipped and recorded.

## Config fields

| Field | Meaning |
| --- | --- |
| `id` | Name. It becomes the fact `source`. |
| `match.task` | Regex on the task id. The connector runs only when it matches. |
| `match.agent` | Regex on the subagent name. Omit a `match` key to match everything. |
| `command` | argv array, run without a shell. `{task}` is replaced in each element. |
| `http` | `{ url, method?, headers?, body?, labelsPath? }`. Use `command` or `http`, not both. |
| `labelsPath` | Dot path to the label array. Default `labels`. `http.labelsPath` wins for http. |
| `timeoutMs` | Hard limit for one call. The dispatch never waits longer. The command is killed. |
| `ttlMinutes` | How long a good result is cached per task. Errors are cached for 1 minute. |
| `map` | Rules applied to the labels, see below. |

The label array holds strings or objects with a `name`.

### Map rules

```jsonc
{ "label": "^tier:T1$", "set": { "risk": "high" } }
{ "label": "^route:frontier$", "override": { "level": "frontier" } }
```

- `label` is a case-insensitive regex tested on every label. Several rules may match.
- `set` adds one fact per key. Each fact records `source: <id>` and `detail: label <name>`.
- `override.level` pins the level. If several rules set one, the first wins.

### Safety

- The task id must match `^[A-Za-z0-9._#/-]{1,64}$`. Otherwise the connector is skipped with the
  error `bad task id`, and nothing is run or sent.
- `{task}` is substituted only after that check: in argv elements, in the URL (URL-encoded), and
  in string values of the JSON body.
- Header values may use `${ENV_NAME}`. A missing variable is an error. Header values are never
  logged or returned, and are removed from error messages.
- At most one call per connector and task is in flight at once. Each connector keeps at most 50
  cached tasks.

## Example: GitHub

Needs the `gh` CLI signed in.

```jsonc
{
  "id": "github",
  "match": { "task": "^\\d+$" },
  "command": ["gh", "issue", "view", "{task}", "--json", "labels"],
  "timeoutMs": 3000,
  "ttlMinutes": 360,
  "map": [
    { "label": "^tier:T1$", "set": { "risk": "high" } },
    { "label": "^tier:T2$", "set": { "risk": "medium" } },
    { "label": "^tier:T3$", "set": { "risk": "low" } },
    { "label": "^route:frontier$", "override": { "level": "frontier" } }
  ]
}
```

`gh issue view 1047 --json labels` prints `{"labels":[{"name":"tier:T1", ...}]}`, which the default
`labelsPath` reads.

## Example: Linear

Set `LINEAR_API_KEY` in the environment that runs OpenCode.

```jsonc
{
  "id": "linear",
  "match": { "task": "^[A-Z]+-\\d+$" },
  "http": {
    "url": "https://api.linear.app/graphql",
    "method": "POST",
    "headers": { "Authorization": "${LINEAR_API_KEY}" },
    "body": { "query": "query { issue(id: \"{task}\") { labels { nodes { name } } } }" },
    "labelsPath": "data.issue.labels.nodes"
  },
  "timeoutMs": 3000,
  "ttlMinutes": 360,
  "map": [
    { "label": "^tier:T1$", "set": { "risk": "high" } },
    { "label": "^tier:T2$", "set": { "risk": "medium" } },
    { "label": "^tier:T3$", "set": { "risk": "low" } },
    { "label": "^route:frontier$", "override": { "level": "frontier" } }
  ]
}
```

## Testing a connector

`connectors.test(id, task)` runs one connector for one task without the cache and returns the
labels it saw next to the facts, so you can check a `map` before relying on it.
