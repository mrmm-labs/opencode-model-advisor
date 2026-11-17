/**
 * Sends synthetic routing decisions through the BUILT advisor to an OTLP
 * collector, to check spans and metrics end to end. Agent names start with
 * `smoke-` so the data is easy to tell apart.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm smoke:telemetry
 *
 * Decisions go out in waves, so rate() and increase() have more than one point.
 */
import { createAdvisor, type SessionInfo } from "../dist/advisor.js"
import { buildConfig } from "../dist/config.js"
import { Telemetry } from "../dist/otel.js"

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318"
const WAVES = Number(process.env.SMOKE_WAVES ?? 6)
const WAVE_GAP_MS = Number(process.env.SMOKE_WAVE_GAP_MS ?? 12_000)

const config = buildConfig({
  mode: "shadow",
  rules: [
    { id: "smoke-risky", when: { prompt: "(?i)\\bauth\\b" }, tier: "opus" },
    { id: "smoke-read-only", when: { agent: "smoke-explore" }, tier: "haiku" },
    { id: "smoke-big", when: { "hint.files": ">=15" }, tier: "opus" },
  ],
  judge: { enabled: true, timeoutMs: 2000 },
}).config

const sessions: Record<string, SessionInfo> = {}
const opusParent = (n: number) => `smoke-root-${n}`

let judgeCalls = 0
const telemetry = new Telemetry(() => ({ endpoint }))
const advisor = createAdvisor({
  config: () => config,
  telemetry,
  session: async (id) => sessions[id],
  judge: async () => {
    const n = judgeCalls++
    await new Promise((r) => setTimeout(r, 150 + ((n * 211) % 1700)))
    if (n % 7 === 6) throw new Error("smoke judge failure")
    const tier = ["haiku", "sonnet", "opus"][n % 3]
    return `{"tier":"${tier}","reason":"smoke judge verdict ${n}"}`
  },
})

const agents = ["smoke-builder", "smoke-reviewer", "smoke-explore"]
const prompts = [
  "implement the parser",
  "review the auth flow",
  "list the files [[route: task=SMOKE-1 files=3]]",
  "rewrite the module [[route: task=SMOKE-2 tier=high files=20]]",
  "summarise [[advisor: haiku]]",
  "fix failing test [[route: task=SMOKE-3 retry=1]]",
  "fix failing test again [[route: task=SMOKE-3 retry=2]]",
]

let n = 0
for (let wave = 0; wave < WAVES; wave++) {
  for (let i = 0; i < 8; i++, n++) {
    const root = opusParent(n)
    const child = `smoke-child-${n}`
    sessions[root] = {
      model: n % 4 === 0 ? "claude-sonnet-5-5" : "claude-opus-5-5",
    }
    sessions[child] = { parentID: root, model: sessions[root].model }
    const agent = agents[n % agents.length]
    await advisor.decide({
      sessionID: child,
      agent,
      prompt: prompts[n % prompts.length],
    })

    // The routed child session and one step of it, for the shadow saving estimate.
    const grand = `smoke-grand-${n}`
    advisor.onEvent({
      type: "session.created",
      data: {
        sessionID: grand,
        parentID: child,
        agent,
        model: { id: sessions[child].model },
      },
    })
    advisor.onEvent({
      type: "session.step.ended",
      data: {
        sessionID: grand,
        cost: 0,
        tokens: {
          input: 40_000,
          output: 800,
          reasoning: 0,
          cache: { read: 90_000, write: 4_000 },
        },
      },
    })
  }
  console.log(`wave ${wave + 1}/${WAVES}: ${n} decisions so far`)
  if (wave < WAVES - 1) await new Promise((r) => setTimeout(r, WAVE_GAP_MS))
}
await advisor.dispose()
console.log(`sent ${n} decisions to ${endpoint}`)
