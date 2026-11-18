import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { wallNow } from "./clock.ts"

describe("wallNow", () => {
  it("tracks Date.now() within a millisecond", () => {
    const d = Date.now()
    const w = wallNow()
    assert.ok(w >= d && w < Date.now() + 1, `${w} vs ${d}`)
  })
})
