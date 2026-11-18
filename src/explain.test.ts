import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  derivedFacts,
  explain,
  pathsIn,
  resolveFacts,
  scoreDifficulty,
} from "./explain.ts"
import {
  defaultRoutingV2,
  type FactInput,
  type FactName,
  type FactValue,
  type SourceKind,
} from "./route-v2.ts"

const f = (
  fact: FactName,
  value: FactValue,
  kind: SourceKind = "caller",
  source = kind,
): FactInput => ({ fact, value, kind, source })

const cfg = defaultRoutingV2

describe("resolveFacts", () => {
  it("takes the strongest source and keeps the losers", () => {
    const { facts, disagreements } = resolveFacts([
      f("files", 3, "derived", "plugin"),
      f("files", 12, "caller", "hint"),
      f("files", 20, "connector", "github"),
    ])
    assert.equal(facts.files?.value, 20)
    assert.equal(facts.files?.source, "github")
    assert.deepEqual(facts.files?.others, [
      { value: 3, kind: "derived", source: "plugin" },
      { value: 12, kind: "caller", source: "hint" },
    ])
    assert.equal(disagreements.length, 1)
    assert.deepEqual(disagreements[0], {
      fact: "files",
      chosen: 20,
      chosenSource: "github",
      values: [
        { value: 3, source: "plugin" },
        { value: 12, source: "hint" },
        { value: 20, source: "github" },
      ],
    })
  })

  it("breaks a tie by the first given", () => {
    const { facts } = resolveFacts([
      f("files", 5, "caller", "first"),
      f("files", 9, "caller", "second"),
    ])
    assert.equal(facts.files?.value, 5)
  })

  it("lets override beat everything and default lose to everything", () => {
    const { facts } = resolveFacts([
      f("kind", "new", "default", "config"),
      f("kind", "edit", "caller", "hint"),
      f("kind", "refactor", "override", "operator"),
    ])
    assert.equal(facts.kind?.value, "refactor")
  })

  it("takes the highest risk from any source", () => {
    const { facts, disagreements } = resolveFacts([
      f("risk", "high", "derived", "plugin"),
      f("risk", "low", "override", "operator"),
      f("risk", "critical", "default", "config"),
      f("risk", "medium", "connector", "github"),
    ])
    assert.equal(facts.risk?.value, "critical")
    assert.equal(facts.risk?.source, "config")
    assert.equal(facts.risk?.others.length, 3)
    assert.equal(disagreements[0].chosen, "critical")
  })

  it("prefers the stronger source among equal risks, and no disagreement when values agree", () => {
    const { facts, disagreements } = resolveFacts([
      f("risk", "high", "caller", "hint"),
      f("risk", "high", "connector", "github"),
    ])
    assert.equal(facts.risk?.source, "github")
    assert.deepEqual(disagreements, [])
  })

  it("compares array values by content", () => {
    const { disagreements } = resolveFacts([
      f("paths", ["a/b.ts"], "derived", "plugin"),
      f("paths", ["a/b.ts"], "caller", "hint"),
    ])
    assert.deepEqual(disagreements, [])
  })

  it("keeps detail on the winner", () => {
    const { facts } = resolveFacts([
      { ...f("risk", "high", "connector", "github"), detail: "label tier:T1" },
    ])
    assert.equal(facts.risk?.detail, "label tier:T1")
  })
})

describe("scoreDifficulty", () => {
  const score = (inputs: FactInput[], points = cfg().difficulty.points) => {
    const c = cfg()
    c.difficulty.points = points
    return scoreDifficulty(resolveFacts(inputs).facts, c)
  }

  it("scores gte, eq, in and per with max, and lists only lines that added", () => {
    const s = score([
      f("files", 20),
      f("modules", 1),
      f("migration", true),
      f("kind", "refactor"),
      f("unknowns", 5),
    ])
    assert.deepEqual(s.breakdown, [
      { fact: "files", add: 2 },
      { fact: "migration", add: 2 },
      { fact: "kind", add: 1 },
      { fact: "unknowns", add: 3 },
    ])
    assert.equal(s.total, 8)
    assert.equal(s.difficulty, "high")
  })

  it("adds per unit and scales", () => {
    const s = score([f("priorFailures", 2)])
    assert.deepEqual(s.breakdown, [{ fact: "priorFailures", add: 4 }])
    assert.equal(s.difficulty, "high")
  })

  it("applies the cutoffs at their edges", () => {
    assert.equal(score([f("unknowns", 1)]).difficulty, "low")
    assert.equal(score([f("unknowns", 2)]).difficulty, "medium")
    assert.equal(score([f("unknowns", 2), f("files", 15)]).difficulty, "high")
  })

  it("needs every condition on a line, and ignores absent facts", () => {
    const points = [{ fact: "files" as const, gte: 5, eq: 9, add: 1 }]
    assert.equal(score([f("files", 7)], points).total, 0)
    assert.equal(score([f("files", 9)], points).total, 1)
    assert.equal(score([], points).total, 0)
  })

  it("reads numeric strings and path counts, and booleans loosely", () => {
    const s = score(
      [f("files", "16"), f("migration", "TRUE"), f("paths", ["a/b", "c/d"])],
      [
        { fact: "files", gte: 15, add: 2 },
        { fact: "migration", eq: true, add: 1 },
        { fact: "paths", gte: 2, add: 4 },
      ],
    )
    assert.equal(s.total, 7)
  })
})

describe("explain", () => {
  const run = (
    inputs: FactInput[],
    over: Partial<Parameters<typeof explain>[0]> = {},
    config = cfg(),
  ) => explain({ agent: "builder", prompt: "", inputs, ...over }, config)

  it("defaults risk and walks the matrix", () => {
    const d = run([])
    assert.equal(d.risk, "medium")
    assert.equal(d.facts.risk?.kind, "default")
    assert.equal(d.matrixLevel, "standard")
    assert.equal(d.level, "standard")
    assert.equal(d.model, "anthropic/claude-sonnet-5-5")
    assert.deepEqual(d.steps, ["matrix medium×low → standard"])
    assert.deepEqual(d.connectors, [])
  })

  it("does not let the default risk outvote a lower caller risk", () => {
    const d = run([f("risk", "low")])
    assert.equal(d.risk, "low")
    assert.equal(d.level, "fast")
    assert.deepEqual(d.disagreements, [])
  })

  it("reads the matrix on difficulty", () => {
    const d = run([f("risk", "low"), f("files", 20), f("modules", 4)])
    assert.equal(d.score.difficulty, "high")
    assert.equal(d.level, "frontier")
    assert.equal(d.steps[0], "matrix low×high → frontier")
  })

  it("raises to the risk floor and never lowers", () => {
    const c = cfg()
    c.policy.matrix.high.low = "fast"
    const d = run([f("risk", "high")], {}, c)
    assert.equal(d.matrixLevel, "fast")
    assert.equal(d.level, "frontier")
    assert.deepEqual(d.steps, [
      "matrix high×low → fast",
      "risk floor high → frontier",
    ])
    const up = cfg()
    up.policy.riskFloor = { medium: "fast" }
    assert.equal(run([f("risk", "medium")], {}, up).level, "standard")
  })

  it("steps up per retry and stops at the top", () => {
    const one = run([f("risk", "low"), f("retry", 1)])
    assert.equal(one.level, "standard")
    assert.equal(one.steps.at(-1), "retry 1 → standard")
    const two = run([f("risk", "low"), f("retry", 2)])
    assert.equal(two.level, "frontier")
    assert.equal(two.steps.at(-1), "retry 2 → frontier (top)")
    const many = run([f("risk", "low"), f("retry", 9)])
    assert.equal(many.level, "frontier")
    const wide = cfg()
    wide.policy.retryStep = 2
    assert.equal(
      run([f("risk", "low"), f("retry", 1)], {}, wide).level,
      "frontier",
    )
  })

  it("lets an operator override win over matrix, floor and retry", () => {
    const d = run([f("risk", "critical"), f("retry", 3)], {
      override: { level: "fast", detail: "github label route:fast" },
    })
    assert.equal(d.level, "fast")
    assert.equal(d.model, "anthropic/claude-haiku-5-5")
    assert.equal(d.steps.at(-1), "override github label route:fast")
    assert.equal(d.matrixLevel, "frontier")
  })

  it("ignores an override naming no level", () => {
    const d = run([], { override: { level: "nope", detail: "x" } })
    assert.equal(d.level, "standard")
    assert.match(d.steps.at(-1) as string, /ignored/)
  })

  it("carries the score breakdown and disagreements", () => {
    const d = run([
      f("risk", "low", "caller", "hint"),
      f("risk", "high", "connector", "github"),
      f("files", 15),
    ])
    assert.equal(d.risk, "high")
    assert.equal(d.score.total, 2)
    assert.equal(d.disagreements.length, 1)
    assert.equal(d.level, "frontier")
  })
})

describe("derived facts", () => {
  it("counts prompt tokens as chars / 4, rounded up", () => {
    const [tokens] = derivedFacts("x".repeat(9), {}, false)
    assert.deepEqual(tokens, {
      fact: "promptTokens",
      value: 3,
      kind: "derived",
      source: "plugin",
    })
  })

  it("finds path-like tokens, not urls or words", () => {
    assert.deepEqual(
      pathsIn(
        "Edit src/app/main.ts and `./lib/x`, see https://example.com/a/b.html; either and/or, docs/api/ too.",
      ),
      ["src/app/main.ts", "./lib/x", "docs/api/"],
    )
  })

  it("caps paths at 20", () => {
    const prompt = Array.from({ length: 30 }, (_, n) => `a/f${n}.ts`).join(" ")
    assert.equal(pathsIn(prompt).length, 20)
  })

  it("sets priorFailures from retry only for a task dispatched before", () => {
    const names = (hint: object, before: boolean) =>
      derivedFacts("p", hint, before).map((i) => i.fact)
    assert.ok(names({ task: "1", retry: 2 }, true).includes("priorFailures"))
    assert.ok(!names({ task: "1", retry: 2 }, false).includes("priorFailures"))
    assert.ok(!names({ task: "1", retry: 0 }, true).includes("priorFailures"))
    assert.ok(!names({ retry: 2 }, true).includes("priorFailures"))
  })
})
