import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { redact, summarize } from "./summary.ts"

describe("summarize", () => {
  it("keeps the first words of the task on one line", () => {
    assert.equal(
      summarize("Review the\n  login   flow [[route: task=1 risk=high]] now"),
      "Review the login flow now",
    )
    const long = summarize("word ".repeat(40))
    assert.ok(long.length <= 80)
    assert.match(long, /…$/)
    assert.equal(summarize(undefined), "")
  })

  it("filters credentials before they are stored", () => {
    for (const secret of [
      "sk-ant-api03-abcdefgh12345678",
      "ghp_abcdefghijklmnop1234",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123",
      "Bearer abcdef0123456789",
      "API_KEY=hunter2hunter2",
      "password: s3cr3t",
      "a".repeat(40),
    ]) {
      const out = summarize(`call with ${secret} please`)
      assert.ok(!out.includes(secret.split(/[:=]\s*/).at(-1)!), out)
      assert.match(out, /\[secret\]/)
    }
    assert.equal(
      redact("fix the auth bug in login.ts"),
      "fix the auth bug in login.ts",
    )
  })
})
