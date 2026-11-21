## Context

Executor usage is only visible as OpenCode 2 session events; advisor usage only inside the Messages response, where `stream-filter.ts` removes it so OpenCode can round-trip the turn. The TUI runs in another process and reads files.

## Decisions

- **Executor from events.** `session.step.started` carries agent and model, keyed by `assistantMessageID`; `session.step.ended` carries cost and tokens. The filter already removes advisor tokens from the executor's usage, so executor and advisor rows never overlap.
- **Advisor per call.** `AdvisorUsage` gains `calls: AdvisorCall[]`, filled before the entries are dropped.
- **Cost.** Reported cost when above zero, else list price from tokens (reasoning priced as output), same as the saving estimate. A row carries `est: true` when priced at list.
- **Store.** One JSONL file, not SQLite: appends from several processes are atomic enough, and no dependency. Past 2 MB the file is rewritten as day aggregates. Rows of other processes appended during the rewrite can be lost; accepted for an accounting view.
- **Saving.** The step's saving (shadow: would save; enforce: saved) is stored on the executor row, since the decisions file keeps only 2000 records.
- **Points.** No source of the weekly limit exists in the plugin; shown as `n/a`.
