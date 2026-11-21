import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  filterMessage,
  filterStream,
  StreamFilter,
  type AdvisorUsage,
} from "./stream-filter.ts"

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const RAW = fixture("advisor-response.sse")
const STRIPPED = fixture("advisor-response.stripped.sse")

type Event = { type: string; index?: number; [k: string]: any }
const events = (sse: string): Event[] =>
  sse
    .split("\n\n")
    .filter((e) => e.trim())
    .map((e) =>
      JSON.parse(
        e
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(5),
      ),
    )

function run(input: string, size: number) {
  const f = new StreamFilter()
  let out = ""
  for (let i = 0; i < input.length; i += size)
    out += f.push(input.slice(i, i + size))
  out += f.end()
  return { out, usage: f.usage }
}

// The validated reference drops `iterations` entirely; the filter keeps the executor's own.
const withoutIterations = (list: Event[]) =>
  list.map((e) => {
    if (e.type === "message_delta") delete e.usage.iterations
    return e
  })

describe("advisor stream filter", () => {
  it("has no secrets left in the fixture", () => {
    assert.ok(RAW.includes('"encrypted_content":"REDACTED"'))
    assert.ok(!/@|\/Users\//.test(RAW))
  })

  for (const size of [1, 7, 64, 1000, RAW.length]) {
    it(`matches the validated reference when fed ${size}-character chunks`, () => {
      const { out } = run(RAW, size)
      assert.deepEqual(withoutIterations(events(out)), events(STRIPPED))
    })
  }

  it("drops the advisor blocks and renumbers the rest contiguously", () => {
    const list = events(run(RAW, 100).out)
    assert.ok(
      !list.some(
        (e) =>
          e.content_block?.type === "advisor_tool_result" ||
          e.content_block?.name === "advisor",
      ),
    )
    const starts = list.filter((e) => e.type === "content_block_start")
    assert.deepEqual(
      starts.map((e) => e.index),
      starts.map((_, n) => n),
    )
    const indexes = new Set(
      list
        .filter((e) => e.type.startsWith("content_block"))
        .map((e) => e.index),
    )
    assert.deepEqual([...indexes], [0])
  })

  it("moves the advisor iteration out of usage and reports it", () => {
    const { out, usage } = run(RAW, 100)
    const delta = events(out).find((e) => e.type === "message_delta")!
    assert.deepEqual(
      delta.usage.iterations.map((i: any) => i.type),
      ["message", "message"],
    )
    assert.equal(delta.usage.input_tokens, 4)
    assert.equal(delta.usage.output_tokens, 622)
    assert.deepEqual(usage, {
      calls: 1,
      inputTokens: 29025,
      outputTokens: 1763,
      cacheRead: 0,
      cacheWrite: 0,
      model: "claude-opus-5-5",
      perCall: [
        {
          model: "claude-opus-5-5",
          input: 29025,
          output: 1763,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    })
  })

  it("passes everything else through byte for byte", () => {
    const plain = STRIPPED.replace(/"index":0/g, '"index":0')
    const { out, usage } = run(plain, 13)
    assert.equal(out, plain)
    assert.equal(usage.calls, 0)
  })

  it("keeps a trailing partial event and CRLF framing intact", () => {
    const crlf =
      'event: ping\r\ndata: {"type": "ping"}\r\n\r\nevent: x\r\ndata: {"type":"x"}'
    assert.equal(run(crlf, 5).out, crlf)
  })

  it("leaves a stream without advisor blocks untouched even with block indexes", () => {
    const sse = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"say \\"index\\":5"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      "",
    ].join("\n\n")
    assert.equal(run(sse, 9).out, sse)
  })

  it("filters a ReadableStream chunk by chunk and reports usage at the end", async () => {
    const bytes = new TextEncoder().encode(RAW)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 333)
          controller.enqueue(bytes.slice(i, i + 333))
        controller.close()
      },
    })
    let usage: AdvisorUsage | undefined
    const chunks: string[] = []
    const reader = filterStream(source, (u) => (usage = u)).getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    assert.ok(chunks.length > 3, "streamed in several chunks")
    assert.deepEqual(
      withoutIterations(events(chunks.join(""))),
      events(STRIPPED),
    )
    assert.equal(usage?.calls, 1)
  })

  it("filters a non-streaming message the same way", () => {
    const message = {
      content: [
        { type: "server_tool_use", name: "advisor", id: "s" },
        { type: "advisor_tool_result", tool_use_id: "s", content: {} },
        { type: "server_tool_use", name: "web_search", id: "w" },
        { type: "text", text: "hi" },
      ],
      usage: {
        input_tokens: 99,
        output_tokens: 99,
        iterations: [
          { type: "message", input_tokens: 3, output_tokens: 4 },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            input_tokens: 90,
            output_tokens: 95,
          },
        ],
      },
    }
    const usage = filterMessage(message)
    assert.deepEqual(
      message.content.map((b) => b.type),
      ["server_tool_use", "text"],
    )
    assert.equal(message.usage.input_tokens, 3)
    assert.equal(message.usage.output_tokens, 4)
    assert.equal(usage.calls, 1)
    assert.equal(usage.inputTokens, 90)
  })

  it("keeps each advisor call with its own model and cache tokens", () => {
    const message = {
      content: [],
      usage: {
        iterations: [
          { type: "message", input_tokens: 3, output_tokens: 4 },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            input_tokens: 90,
            output_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
          },
          { type: "advisor_message", input_tokens: 7, output_tokens: 8 },
        ],
      },
    }
    assert.deepEqual(filterMessage(message).perCall, [
      {
        model: "claude-opus-5-5",
        input: 90,
        output: 10,
        cacheRead: 5,
        cacheWrite: 6,
      },
      { model: undefined, input: 7, output: 8, cacheRead: 0, cacheWrite: 0 },
    ])
  })
})
