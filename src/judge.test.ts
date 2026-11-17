import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildConfig } from "./config.ts"
import { judgePrompt, parseJudgeReply, runJudge } from "./judge.ts"

const config = buildConfig({ judge: { enabled: true, timeoutMs: 50 } }).config

describe("parseJudgeReply", () => {
  it("reads json with surrounding prose and any tier case", () => {
    assert.deepEqual(
      parseJudgeReply('Sure: {"tier":"Opus","reason":"hard"} ok', config),
      {
        tier: "opus",
        reason: "hard",
      },
    )
  })

  it("rejects unknown tiers, bad json and no json", () => {
    assert.equal(
      parseJudgeReply('{"tier":"gpt","reason":"x"}', config),
      undefined,
    )
    assert.equal(parseJudgeReply('{"tier": opus}', config), undefined)
    assert.equal(parseJudgeReply("opus", config), undefined)
  })

  it("caps the reason and defaults it", () => {
    assert.equal(
      parseJudgeReply(`{"tier":"haiku","reason":"${"x".repeat(500)}"}`, config)
        ?.reason.length,
      200,
    )
    assert.equal(parseJudgeReply('{"tier":"haiku"}', config)?.reason, "judge")
  })
})

describe("judgePrompt", () => {
  it("lists the tiers and cuts the task at 4000 characters", () => {
    const p = judgePrompt(config, "builder", "Ω".repeat(9000))
    assert.match(p, /haiku, sonnet, opus/)
    assert.equal((p.match(/Ω/g) ?? []).length, 4000)
  })
})

describe("runJudge", () => {
  it("returns the parsed tier and sends the configured model", async () => {
    let seen: { model: object; prompt: string } | undefined
    const r = await runJudge(
      async (req) => {
        seen = req
        return '{"tier":"opus","reason":"auth code"}'
      },
      config,
      "builder",
      "change auth",
    )
    assert.equal(r.ok && r.tier, "opus")
    assert.deepEqual(seen?.model, {
      providerID: "anthropic",
      id: "claude-haiku-5-5",
    })
    assert.match(seen?.prompt ?? "", /change auth/)
  })

  it("splits a provider-qualified judge model", async () => {
    const c = buildConfig({
      judge: { enabled: true, model: "other/m-1" },
    }).config
    let model: object | undefined
    await runJudge(
      async (r) => ((model = r.model), '{"tier":"opus"}'),
      c,
      "a",
      "p",
    )
    assert.deepEqual(model, { providerID: "other", id: "m-1" })
  })

  it("times out, aborting the call", async () => {
    let aborted = false
    const r = await runJudge(
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        }),
      config,
      "a",
      "p",
    )
    assert.equal(!r.ok && r.outcome, "timeout")
    assert.equal(aborted, true)
  })

  it("reports a thrown error and an unusable reply", async () => {
    const thrown = await runJudge(
      async () => Promise.reject(new Error("boom")),
      config,
      "a",
      "p",
    )
    assert.deepEqual(
      [!thrown.ok && thrown.outcome, !thrown.ok && thrown.reason],
      ["error", "judge failed: boom"],
    )
    const junk = await runJudge(async () => "no idea", config, "a", "p")
    assert.equal(!junk.ok && junk.outcome, "invalid")
  })
})
