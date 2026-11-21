## 1. Usage core

- [x] 1.1 `src/usage.ts`: row type, append, fold, read, window aggregate, report lines. Verify: `src/usage.test.ts`.
- [x] 1.2 `stream-filter.ts`: keep each advisor call. Verify: `src/stream-filter.test.ts`.

## 2. Recording

- [x] 2.1 Executor rows in `advisor.ts` `onEvent`. Verify: `src/advisor.test.ts`.
- [x] 2.2 Advisor rows in `advise.ts` and `advisor-tool.ts`; metrics. Verify: `src/advise.test.ts`, `src/advisor-tool.test.ts`.

## 3. Display

- [x] 3.1 `usage` sub-command and TUI wiring. Verify: `src/commands.test.ts`.
- [x] 3.2 Sidebar `Today` and `Saving` rows. Verify: `src/view.test.ts`.
- [x] 3.3 Docs, README, Grafana panels. Verify: `mise run check`.

## 4. Release

- [x] 4.1 `openspec validate --strict`, PR, CI green, release.
