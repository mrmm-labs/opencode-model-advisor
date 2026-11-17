import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { inputPrice, listCostUsd, savingUsd } from "./pricing.ts"

describe("pricing", () => {
  it("knows the families by name", () => {
    assert.deepEqual(
      [
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "anthropic/claude-opus-5-5",
        "gpt",
      ].map(inputPrice),
      [1, 3, 5, undefined],
    )
  })

  it("prices tokens with the output, cache read and cache write multipliers", () => {
    const usage = { input: 1e6, output: 1e6, cache: { read: 1e6, write: 1e6 } }
    // sonnet: 3 + 15 + 0.3 + 3.75
    assert.ok(
      Math.abs((listCostUsd("claude-sonnet-5-5", usage) ?? 0) - 22.05) < 1e-9,
    )
    assert.equal(listCostUsd("mystery", usage), undefined)
  })

  it("estimates saving as cost x (1 - price(would) / price(actual))", () => {
    assert.ok(
      Math.abs(
        (savingUsd(10, "claude-opus-5-5", "claude-sonnet-5-5") ?? 0) - 4,
      ) < 1e-9,
    )
    assert.ok(
      Math.abs(
        (savingUsd(3, "claude-sonnet-5-5", "claude-opus-5-5") ?? 0) + 2,
      ) < 1e-9,
    )
    assert.equal(savingUsd(1, "claude-opus-5-5", "claude-opus-5-5"), 0)
    assert.equal(savingUsd(1, "x", "claude-opus-5-5"), undefined)
  })
})
