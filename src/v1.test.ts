import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { server } from "./v1.ts"

const input = { client: { session: {} } } as never

describe("OpenCode 1 entry with routing v2 off", () => {
  it("offers no advisor tool and adds no system line", async () => {
    const hooks = await server(input)
    assert.equal(hooks.tool, undefined)
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "builder" },
      {} as never,
    )
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "s", model: { providerID: "openai", id: "gpt-5" } as never },
      output,
    )
    assert.deepEqual(output.system, ["base"])
  })
})
