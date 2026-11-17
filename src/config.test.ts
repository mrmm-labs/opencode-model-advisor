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
})
