import type {
  DecisionV2,
  ExplainInput,
  FactInput,
  Facts,
  Disagreement,
  RoutingV2Config,
  Score,
} from "./route-v2.ts"

// Stubs: the core builder replaces these bodies (contract in route-v2.ts).
export function resolveFacts(_inputs: FactInput[]): {
  facts: Facts
  disagreements: Disagreement[]
} {
  throw new Error("resolveFacts: not implemented")
}

export function scoreDifficulty(_facts: Facts, _cfg: RoutingV2Config): Score {
  throw new Error("scoreDifficulty: not implemented")
}

export function explain(
  _input: ExplainInput,
  _cfg: RoutingV2Config,
): DecisionV2 {
  throw new Error("explain: not implemented")
}
