import assert from "node:assert/strict"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  bareModel,
  buildConfig,
  ConfigStore,
  configPath,
  defaultConfig,
  matchValue,
  qualify,
  resolveTier,
} from "./config.ts"
import { parseJsonc } from "./jsonc.ts"
import { defaultRoutingV2 } from "./route-v2.ts"

const input = (
  over: Partial<{ agent: string; prompt: string; hint: object }> = {},
) => ({
  agent: "builder",
  prompt: "do work",
  hint: {},
  ...over,
})

describe("matchValue", () => {
  it("compares numbers, strings, lists and operators", () => {
    assert.equal(matchValue(15, ">=15"), true)
    assert.equal(matchValue(14, ">=15"), false)
    assert.equal(matchValue(3, "<5"), true)
    assert.equal(matchValue(5, "==5"), true)
    assert.equal(matchValue(5, 5), true)
    assert.equal(matchValue("High", ["high", "critical"]), true)
    assert.equal(matchValue("low", ["high", "critical"]), false)
    assert.equal(matchValue(undefined, ">=1"), false)
    assert.equal(matchValue("abc", ">=1"), false)
  })
})

describe("buildConfig", () => {
  it("returns shadow defaults for nothing or garbage", () => {
    assert.equal(buildConfig(undefined).config.mode, "shadow")
    const bad = buildConfig(42)
    assert.equal(bad.config.mode, "shadow")
    assert.equal(bad.warnings.length, 1)
  })

  it("reads the sidebar position and warns on a bad one", () => {
    assert.equal(buildConfig({}).config.tui.position, "top")
    const ok = buildConfig({ tui: { position: "bottom" } })
    assert.equal(ok.config.tui.position, "bottom")
    assert.deepEqual(ok.warnings, [])
    const bad = buildConfig({ tui: { position: "left" } })
    assert.equal(bad.config.tui.position, "top")
    assert.equal(bad.warnings.length, 1)
  })

  it("reads mode, tiers, ladder order and default", () => {
    const { config, warnings } = buildConfig({
      mode: "enforce",
      tiers: { Small: "m-small", big: "m-big" },
      default: "BIG",
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.mode, "enforce")
    assert.deepEqual(config.ladder, ["small", "big"])
    assert.equal(config.default, "big")
  })

  it("warns and falls back on bad values", () => {
    const { config, warnings } = buildConfig({
      mode: "yolo",
      default: "gold",
      judge: { timeoutMs: -1 },
      pins: { builder: "nope", reviewer: "opus" },
    })
    assert.equal(config.mode, "shadow")
    assert.equal(config.default, "sonnet")
    assert.deepEqual(config.pins, { reviewer: "opus" })
    assert.equal(warnings.length, 4)
    assert.equal(config.judge.timeoutMs, 8000)
  })

  it("compiles rules and drops broken ones with a warning", () => {
    const { config, warnings } = buildConfig({
      rules: [
        {
          id: "risky",
          when: { prompt: "(?i)\\b(auth|crypto)\\b" },
          tier: "opus",
        },
        { id: "big", when: { "hint.files": ">=15" }, tier: "opus" },
        {
          id: "agents",
          when: { agent: ["Explore", "investigator"] },
          tier: "sonnet",
        },
        { id: "long", when: { "prompt.length": ">=100" }, tier: "opus" },
        { id: "bad-regex", when: { prompt: "(" }, tier: "opus" },
        { id: "bad-key", when: { color: "red" }, tier: "opus" },
        { id: "bad-tier", when: { agent: "x" }, tier: "gold" },
        { id: "empty", when: {}, tier: "opus" },
        "nonsense",
      ],
    })
    assert.deepEqual(
      config.rules.map((r) => r.id),
      ["risky", "big", "agents", "long"],
    )
    assert.equal(warnings.length, 5)
    const [risky, big, agents, long] = config.rules
    assert.equal(risky.test(input({ prompt: "fix AUTH flow" })), true)
    assert.equal(risky.test(input({ prompt: "author notes" })), false)
    assert.equal(big.test(input({ hint: { files: 20 } })), true)
    assert.equal(big.test(input({ hint: { files: 3 } })), false)
    assert.equal(big.test(input()), false)
    assert.equal(agents.test(input({ agent: "explore" })), true)
    assert.equal(long.test(input({ prompt: "x".repeat(100) })), true)
  })

  it("requires every condition of a rule (AND)", () => {
    const { config } = buildConfig({
      rules: [
        {
          id: "both",
          when: { agent: "builder", "hint.tier": "high" },
          tier: "opus",
        },
      ],
    })
    const [rule] = config.rules
    assert.equal(rule.test(input({ hint: { tier: "high" } })), true)
    assert.equal(rule.test(input({ hint: { tier: "low" } })), false)
    assert.equal(
      rule.test(input({ agent: "other", hint: { tier: "high" } })),
      false,
    )
  })

  it("reads otel and judge settings; ignores unknown keys such as advisor", () => {
    const { config, warnings } = buildConfig({
      judge: { enabled: true, model: "claude-haiku-5-5", timeoutMs: 100 },
      otel: { endpoint: "http://x:4318", headers: { a: "b", c: 1 } },
      advisor: { enabled: true },
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.judge.enabled, true)
    assert.equal(config.judge.timeoutMs, 100)
    assert.deepEqual(config.otel, {
      endpoint: "http://x:4318",
      headers: { a: "b" },
    })
  })
})

describe("model helpers", () => {
  it("resolves tier names and model fragments", () => {
    const c = defaultConfig()
    assert.equal(resolveTier("OPUS", c), "opus")
    assert.equal(resolveTier("claude-sonnet-5-5", c), "sonnet")
    assert.equal(resolveTier("haik", c), "haiku")
    assert.equal(resolveTier("gpt", c), undefined)
    assert.equal(resolveTier("", c), undefined)
  })

  it("qualifies and strips provider prefixes", () => {
    assert.equal(qualify("claude-x", "anthropic"), "anthropic/claude-x")
    assert.equal(qualify("other/claude-x", "anthropic"), "other/claude-x")
    assert.equal(bareModel("anthropic/claude-x"), "claude-x")
    assert.equal(bareModel(undefined), "")
  })
})

describe("ConfigStore", () => {
  it("defaults when the file is missing, loads it, and reloads on change", () => {
    const dir = mkdtempSync(join(tmpdir(), "adv-config-"))
    try {
      const file = join(dir, "model-advisor.jsonc")
      const store = new ConfigStore(() => file)
      assert.equal(store.get().mode, "shadow")

      writeFileSync(file, `{ // enforce\n "mode": "enforce", }`)
      assert.equal(store.get().mode, "enforce")

      writeFileSync(file, `{ "mode": "shadow" }`)
      const later = new Date(Date.now() + 5000)
      utimesSync(file, later, later)
      assert.equal(store.get().mode, "shadow")

      writeFileSync(file, "{ broken")
      utimesSync(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000))
      assert.equal(store.get().mode, "shadow", "keeps the last good config")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("honours the env override and XDG_CONFIG_HOME", () => {
    assert.equal(
      configPath({ OPENCODE_MODEL_ADVISOR_CONFIG: "/x/y.jsonc" }),
      "/x/y.jsonc",
    )
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/cfg" }),
      join("/cfg", "opencode", "model-advisor.jsonc"),
    )
  })
})

describe("example config", () => {
  it("parses without warnings", () => {
    const text = readFileSync(
      new URL("../model-advisor.example.jsonc", import.meta.url),
      "utf8",
    )
    const { config, warnings } = buildConfig(parseJsonc(text))
    assert.deepEqual(warnings, [])
    assert.equal(config.mode, "shadow")
    assert.equal(config.rules.length, 5)
  })

  it("reads the advisor block, defaulting its model to the top tier", () => {
    const off = buildConfig({}).config.advisor
    assert.deepEqual(off, {
      enabled: false,
      model: "claude-opus-5-5",
      maxUses: 2,
      maxContextTokens: 120_000,
      alertSteps: 15,
    })
    const custom = buildConfig({
      tiers: { small: "m-small", big: "m-big" },
      advisor: { enabled: true, maxUses: 4, alertSteps: 9 },
    }).config.advisor
    assert.equal(custom.model, "m-big")
    assert.equal(custom.enabled, true)
    assert.equal(custom.maxUses, 4)
    assert.equal(custom.alertSteps, 9)
    assert.equal(
      buildConfig({ advisor: { model: "claude-opus-5-5-x" } }).config.advisor
        .model,
      "claude-opus-5-5-x",
    )
  })

  it("warns and keeps defaults for a bad advisor setting", () => {
    const { config, warnings } = buildConfig({
      advisor: { maxUses: 0, maxContextTokens: "lots", alertSteps: 1.5 },
    })
    assert.equal(config.advisor.maxUses, 2)
    assert.equal(config.advisor.maxContextTokens, 120_000)
    assert.equal(config.advisor.alertSteps, 15)
    assert.equal(warnings.length, 3)
    assert.equal(buildConfig({ advisor: 3 }).warnings.length, 1)
  })
})

describe("routing v2 config", () => {
  const v2 = (raw: object) => buildConfig({ v2: raw })

  it("is off with defaults when absent", () => {
    const { config, warnings } = buildConfig({})
    assert.equal(config.v2.enabled, false)
    assert.deepEqual(config.v2, defaultRoutingV2())
    assert.deepEqual(warnings, [])
  })

  it("enables and merges a partial section over the defaults", () => {
    const { config, warnings } = v2({
      enabled: true,
      defaults: { risk: "low" },
      difficulty: { cutoffs: { high: 6 } },
      policy: { matrix: { low: { low: "standard" } }, retryStep: 2 },
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.v2.enabled, true)
    assert.equal(config.v2.defaults.risk, "low")
    assert.deepEqual(config.v2.difficulty.cutoffs, { medium: 2, high: 6 })
    assert.equal(config.v2.policy.matrix.low.low, "standard")
    assert.equal(config.v2.policy.matrix.low.high, "frontier")
    assert.equal(config.v2.policy.retryStep, 2)
    assert.equal(config.v2.difficulty.points.length, 7)
  })

  it("takes custom levels with their order, and needs a matching policy", () => {
    const levels = { a: { model: "x/a" }, b: { model: "y/b" } }
    const off = v2({ enabled: true, levels })
    assert.equal(off.config.v2.enabled, false)
    assert.deepEqual(off.config.v2.levelOrder, ["a", "b"])
    assert.match(off.warnings.join("\n"), /no level named/)
    const row = { low: "a", medium: "a", high: "b" }
    const ok = v2({
      enabled: true,
      levels,
      policy: {
        matrix: { low: row, medium: row, high: row, critical: row },
        riskFloor: { critical: "b" },
      },
      advisor: { level: "b", impl: "tool" },
    })
    assert.deepEqual(ok.warnings, [])
    assert.equal(ok.config.v2.enabled, true)
    assert.deepEqual(ok.config.v2.policy.riskFloor, { critical: "b" })
    assert.deepEqual(ok.config.v2.advisor, { level: "b", impl: "tool" })
  })

  it("keeps defaults for invalid parts and warns for each", () => {
    const { config, warnings } = v2({
      enabled: "yes",
      levels: { x: {} },
      levelOrder: ["nope"],
      defaults: { risk: "extreme" },
      difficulty: { points: "many", cutoffs: { medium: 5, high: 1 } },
      policy: {
        matrix: { low: { low: "missing" } },
        riskFloor: { high: "missing", bogus: "fast" },
        retryStep: -1,
      },
      advisor: { level: "missing", impl: "magic" },
      calibration: { minFirstPass: 2, minTasks: 0 },
    })
    const d = defaultRoutingV2()
    assert.equal(warnings.length, 14, warnings.join("\n"))
    assert.equal(config.v2.enabled, false)
    assert.deepEqual(config.v2.levels, d.levels)
    assert.deepEqual(config.v2.levelOrder, d.levelOrder)
    assert.equal(config.v2.defaults.risk, "medium")
    assert.deepEqual(config.v2.difficulty, d.difficulty)
    assert.deepEqual(config.v2.policy.matrix, d.policy.matrix)
    assert.deepEqual(config.v2.policy.riskFloor, {})
    assert.equal(config.v2.policy.retryStep, 1)
    assert.deepEqual(config.v2.advisor, d.advisor)
    assert.deepEqual(config.v2.calibration, d.calibration)
  })

  it("drops only the bad rubric lines", () => {
    const { config, warnings } = v2({
      difficulty: {
        points: [
          { fact: "files", gte: 3, add: 1 },
          { fact: "bogus", gte: 3, add: 1 },
          { fact: "files", add: 1 },
          { fact: "kind", in: ["new"], add: "x" },
          { fact: "unknowns", per: 0, add: 1 },
          "nope",
        ],
      },
    })
    assert.deepEqual(config.v2.difficulty.points, [
      { fact: "files", gte: 3, add: 1 },
    ])
    assert.equal(warnings.length, 5)
  })

  it("warns when v2 is not an object", () => {
    assert.equal(buildConfig({ v2: true }).warnings.length, 1)
  })

  describe("connectors", () => {
    const good = {
      id: "github",
      match: { task: "^\\d+$" },
      command: ["gh", "issue", "view", "{task}", "--json", "labels"],
      map: [
        { label: "^tier:T1$", set: { risk: "high", bogus: 1 } },
        { label: "^route:frontier$", override: { level: "frontier" } },
      ],
    }

    it("parses a connector with its defaults", () => {
      const { config, warnings } = v2({ connectors: [good] })
      assert.deepEqual(warnings, [])
      const [c] = config.v2.connectors
      assert.equal(c.timeoutMs, 3000)
      assert.equal(c.ttlMinutes, 360)
      assert.deepEqual(c.map[0].set, { risk: "high" })
      assert.deepEqual(c.map[1].override, { level: "frontier" })
    })

    it("accepts an http connector", () => {
      const { config, warnings } = v2({
        connectors: [
          {
            id: "tracker",
            http: { url: "https://x.test/{task}", method: "POST", body: {} },
            timeoutMs: 10000,
            ttlMinutes: 5,
            map: [],
          },
        ],
      })
      assert.deepEqual(warnings, [])
      assert.equal(config.v2.connectors[0].http?.method, "POST")
      assert.equal(config.v2.connectors[0].timeoutMs, 10000)
    })

    it("drops a bad connector and keeps the good ones", () => {
      const { config, warnings } = v2({
        connectors: [
          good,
          { id: "slow", command: ["x"], timeoutMs: 20000 },
          { id: "nocmd" },
          { id: "re", command: ["x"], match: { task: "(" } },
          { id: "map", command: ["x"], map: [{ label: "[" }] },
          { id: "ttl", command: ["x"], ttlMinutes: 0 },
          { command: ["x"] },
          3,
        ],
      })
      assert.deepEqual(
        config.v2.connectors.map((c) => c.id),
        ["github"],
      )
      assert.equal(warnings.length, 7)
      assert.match(warnings.join("\n"), /timeoutMs/)
    })

    it("warns when connectors is not a list", () => {
      assert.equal(v2({ connectors: {} }).warnings.length, 1)
    })
  })

  it("marks agent-only rules", () => {
    const { config } = buildConfig({
      rules: [
        { id: "a", when: { agent: ["explore"] }, tier: "haiku" },
        { id: "b", when: { agent: "x", prompt: "y" }, tier: "opus" },
        { id: "c", when: { "hint.files": ">=5" }, tier: "opus" },
      ],
    })
    assert.deepEqual(
      config.rules.map((r) => r.agentOnly),
      [true, false, false],
    )
  })
})
