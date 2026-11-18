/** Shared fixture; holds no tests. */
import type { DecisionV2 } from "./route-v2.ts"

export const decision = (over: Partial<DecisionV2> = {}): DecisionV2 => ({
  facts: {
    risk: {
      value: "high",
      kind: "connector",
      source: "github",
      detail: "label tier:T1",
      others: [{ value: "low", kind: "default", source: "config" }],
    },
    files: { value: 18, kind: "caller", source: "hint", others: [] },
    paths: {
      value: ["src/a.ts", "src/b.ts"],
      kind: "derived",
      source: "diff",
      others: [],
    },
    migration: { value: true, kind: "caller", source: "hint", others: [] },
  },
  disagreements: [
    {
      fact: "risk",
      chosen: "high",
      chosenSource: "github",
      values: [
        { value: "high", source: "github" },
        { value: "low", source: "config" },
      ],
    },
  ],
  score: {
    total: 4,
    difficulty: "high",
    breakdown: [
      { fact: "files", add: 2 },
      { fact: "migration", add: 2 },
    ],
  },
  risk: "high",
  matrixLevel: "frontier",
  level: "frontier",
  steps: ["matrix frontier", "floor high -> frontier"],
  model: "anthropic/claude-opus-5-5",
  connectors: [
    { id: "github", ok: true, ms: 41.6, cached: false },
    { id: "linear", ok: false, ms: 5000, cached: false, error: "timeout" },
  ],
  ...over,
})
