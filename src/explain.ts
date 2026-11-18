import {
  SOURCE_ORDER,
  type Difficulty,
  type DecisionV2,
  type ExplainInput,
  type FactInput,
  type FactName,
  type FactValue,
  type Facts,
  type Disagreement,
  type Risk,
  type RoutingV2Config,
  type Score,
} from "./route-v2.ts"

export const RISKS: readonly Risk[] = ["low", "medium", "high", "critical"]

export const isRisk = (v: unknown): v is Risk =>
  typeof v === "string" && (RISKS as readonly string[]).includes(v)

const kindRank = (i: FactInput): number => SOURCE_ORDER.indexOf(i.kind)
const riskRank = (i: FactInput): number =>
  RISKS.indexOf(String(i.value).toLowerCase() as Risk)

/** The strongest source; a tie keeps the first given. */
const strongest = (list: FactInput[]): FactInput =>
  list.reduce((best, i) => (kindRank(i) < kindRank(best) ? i : best))

/**
 * One value per fact: the strongest source wins, a tie goes to the first given.
 * `risk` is the exception: the highest value from any source wins.
 */
export function resolveFacts(inputs: FactInput[]): {
  facts: Facts
  disagreements: Disagreement[]
} {
  const groups = new Map<FactName, FactInput[]>()
  for (const i of inputs) groups.set(i.fact, [...(groups.get(i.fact) ?? []), i])

  const facts: Facts = {}
  const disagreements: Disagreement[] = []
  for (const [fact, list] of groups) {
    let winner: FactInput
    if (fact === "risk") {
      const top = Math.max(...list.map(riskRank))
      winner = strongest(
        top < 0 ? list : list.filter((i) => riskRank(i) === top),
      )
    } else winner = strongest(list)

    facts[fact] = {
      value: winner.value,
      kind: winner.kind,
      source: winner.source,
      ...(winner.detail ? { detail: winner.detail } : {}),
      others: list
        .filter((i) => i !== winner)
        .map(({ value, kind, source }) => ({ value, kind, source })),
    }
    if (new Set(list.map((i) => JSON.stringify(i.value))).size >= 2)
      disagreements.push({
        fact,
        chosen: winner.value,
        chosenSource: winner.source,
        values: list.map(({ value, source }) => ({ value, source })),
      })
  }
  return { facts, disagreements }
}

const numeric = (v: FactValue): number =>
  Array.isArray(v)
    ? v.length
    : typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN

const same = (a: FactValue | undefined, b: FactValue): boolean =>
  a === b ||
  (typeof a !== "object" &&
    typeof b !== "object" &&
    String(a).toLowerCase() === String(b).toLowerCase())

/** Applies the rubric: every condition on a line must hold, `per` scales the points, `max` caps them. */
export function scoreDifficulty(facts: Facts, cfg: RoutingV2Config): Score {
  const breakdown: Score["breakdown"] = []
  for (const p of cfg.difficulty.points) {
    const v = facts[p.fact]?.value
    if (v === undefined) continue
    if (p.gte !== undefined && !(numeric(v) >= p.gte)) continue
    if (p.eq !== undefined && !same(v as FactValue, p.eq)) continue
    if (p.in && !p.in.some((x) => same(v as FactValue, x))) continue
    let add = p.add
    if (p.per !== undefined) {
      const n = numeric(v)
      if (!(n > 0) || !(p.per > 0)) continue
      add = Math.floor(n / p.per) * p.add
    }
    if (p.max !== undefined) add = Math.min(add, p.max)
    if (add !== 0) breakdown.push({ fact: p.fact, add })
  }
  const total = breakdown.reduce((n, b) => n + b.add, 0)
  const { medium, high } = cfg.difficulty.cutoffs
  const difficulty: Difficulty =
    total >= high ? "high" : total >= medium ? "medium" : "low"
  return { total, difficulty, breakdown }
}

const PATH =
  /(?:^|[\s"'`([])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?)(?=$|[\s"'`)\],:;])/g

/** Path-like tokens: two or more segments plus an extension, a trailing slash or a third segment. */
export function pathsIn(prompt: string): string[] {
  const found = new Set<string>()
  for (const m of prompt.matchAll(PATH)) {
    const p = m[1].replace(/\.+$/, "")
    const segments = p.split("/").filter(Boolean)
    const pathLike =
      /^\.{0,2}\//.test(p) ||
      p.endsWith("/") ||
      segments.length >= 3 ||
      /\.\w+$/.test(segments[segments.length - 1] ?? "")
    if (pathLike) found.add(p)
    if (found.size >= 20) break
  }
  return [...found]
}

const derived = (fact: FactName, value: FactValue): FactInput => ({
  fact,
  value,
  kind: "derived",
  source: "plugin",
})

/**
 * Facts the plugin works out itself. `promptTokens` is chars / 4. `priorFailures` is the retry
 * count when this task was already dispatched in this process (the router state knows it) and the
 * caller reports retry >= 1; it is not read from session history.
 */
export function derivedFacts(
  prompt: string,
  hint: { task?: string; retry?: number },
  dispatchedBefore: boolean,
): FactInput[] {
  const out = [derived("promptTokens", Math.ceil(prompt.length / 4))]
  const paths = pathsIn(prompt)
  if (paths.length) out.push(derived("paths", paths))
  if (hint.task && dispatchedBefore && (hint.retry ?? 0) >= 1)
    out.push(derived("priorFailures", hint.retry as number))
  return out
}

/** Resolves the inputs, scores them and walks the policy; pure, so the TUI check command can reuse it. */
export function explain(input: ExplainInput, cfg: RoutingV2Config): DecisionV2 {
  const inputs = [...input.inputs]
  if (!inputs.some((i) => i.fact === "risk"))
    inputs.push({
      fact: "risk",
      value: cfg.defaults.risk,
      kind: "default",
      source: "config",
    })
  const { facts, disagreements } = resolveFacts(inputs)
  const score = scoreDifficulty(facts, cfg)

  const rawRisk = String(facts.risk?.value).toLowerCase()
  const risk: Risk = isRisk(rawRisk) ? rawRisk : cfg.defaults.risk

  const order = cfg.levelOrder
  const top = order.length - 1
  const steps: string[] = []
  const matrixLevel = cfg.policy.matrix[risk][score.difficulty]
  let level = matrixLevel
  steps.push(`matrix ${risk}×${score.difficulty} → ${level}`)

  const floor = cfg.policy.riskFloor[risk]
  if (
    floor &&
    order.indexOf(level) >= 0 &&
    order.indexOf(floor) > order.indexOf(level)
  ) {
    level = floor
    steps.push(`risk floor ${risk} → ${level}`)
  }

  const retry = numeric(facts.retry?.value ?? 0)
  if (retry >= 1 && order.indexOf(level) >= 0) {
    const at = Math.min(
      order.indexOf(level) + cfg.policy.retryStep * retry,
      top,
    )
    level = order[at]
    steps.push(`retry ${retry} → ${level}${at === top ? " (top)" : ""}`)
  }

  if (input.override?.level) {
    if (cfg.levels[input.override.level]) {
      level = input.override.level
      steps.push(`override ${input.override.detail}`)
    } else
      steps.push(
        `override ${input.override.detail} ignored: no level ${input.override.level}`,
      )
  }

  return {
    facts,
    disagreements,
    score,
    risk,
    matrixLevel,
    level,
    steps,
    model: cfg.levels[level].model,
    connectors: [],
  }
}
