/**
 * Removes the advisor's blocks from a Messages response.
 *
 * Without this OpenCode fails on the turn after an advisor call: it cannot
 * round-trip the `advisor` server tool result ("does not know how to round-trip
 * server tool result for advisor"). The filter drops the `server_tool_use`
 * (name `advisor`) and `advisor_tool_result` blocks, renumbers the remaining
 * block indexes, and removes `advisor_message` entries from `usage.iterations`,
 * keeping their numbers for the caller. Every other byte is passed through.
 */
import type { AdvisorCall } from "./usage.ts"

export type AdvisorUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  model?: string
  /** Each advisor call on its own, for per-model accounting. */
  perCall: AdvisorCall[]
}

export const emptyUsage = (): AdvisorUsage => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  perCall: [],
})

type Json = Record<string, any>

const isAdvisorBlock = (block: Json | undefined): boolean =>
  block?.type === "advisor_tool_result" ||
  (block?.type === "server_tool_use" && block.name === "advisor")

const sum = (items: Json[], key: string): number =>
  items.reduce((n, i) => n + (Number(i[key]) || 0), 0)

/**
 * Moves advisor entries out of `usage.iterations`; the top-level token counts
 * become the executor's own. Returns true when anything changed.
 */
function fixUsage(usage: Json | undefined, into: AdvisorUsage): boolean {
  if (!usage || !Array.isArray(usage.iterations)) return false
  const advisor = usage.iterations.filter(
    (i: Json) => i?.type === "advisor_message",
  )
  if (advisor.length === 0) return false
  const executor = usage.iterations.filter(
    (i: Json) => i?.type !== "advisor_message",
  )
  into.calls += advisor.length
  into.inputTokens += sum(advisor, "input_tokens")
  into.outputTokens += sum(advisor, "output_tokens")
  into.cacheRead += sum(advisor, "cache_read_input_tokens")
  into.cacheWrite += sum(advisor, "cache_creation_input_tokens")
  into.model = advisor[advisor.length - 1].model ?? into.model
  for (const i of advisor)
    into.perCall.push({
      model: typeof i.model === "string" ? i.model : undefined,
      input: Number(i.input_tokens) || 0,
      output: Number(i.output_tokens) || 0,
      cacheRead: Number(i.cache_read_input_tokens) || 0,
      cacheWrite: Number(i.cache_creation_input_tokens) || 0,
    })
  usage.iterations = executor
  usage.input_tokens = sum(executor, "input_tokens")
  usage.output_tokens = sum(executor, "output_tokens")
  return true
}

const SEPARATOR = /\r?\n\r?\n/

/** Incremental SSE filter: feed text chunks, get filtered text back. */
export class StreamFilter {
  readonly usage = emptyUsage()
  private buffer = ""
  private dropped = new Set<number>()
  private remap = new Map<number, number>()
  private next = 0

  push(chunk: string): string {
    this.buffer += chunk
    let out = ""
    for (;;) {
      const m = SEPARATOR.exec(this.buffer)
      if (!m) return out
      const end = m.index + m[0].length
      out += this.event(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end)
    }
  }

  end(): string {
    const rest = this.buffer
    this.buffer = ""
    return rest ? this.event(rest) : ""
  }

  private event(raw: string): string {
    const lines = raw.split("\n")
    const at = lines.findIndex((l) => l.startsWith("data:"))
    if (at < 0) return raw
    let data: Json
    try {
      data = JSON.parse(lines[at].slice(5))
    } catch {
      return raw
    }
    switch (data?.type) {
      case "content_block_start":
        if (isAdvisorBlock(data.content_block)) {
          this.dropped.add(data.index)
          return ""
        }
        this.remap.set(data.index, this.next++)
        return this.reindex(raw, data.index)
      case "content_block_delta":
      case "content_block_stop":
        if (this.dropped.has(data.index)) return ""
        return this.reindex(raw, data.index)
      case "message_start":
        return this.rewrite(raw, lines, at, data, data.message?.usage)
      case "message_delta":
        return this.rewrite(raw, lines, at, data, data.usage)
      default:
        return raw
    }
  }

  private reindex(raw: string, from: number): string {
    const to = this.remap.get(from)
    return to === undefined || to === from
      ? raw
      : raw.replace(/("index"\s*:\s*)\d+/, `$1${to}`)
  }

  private rewrite(
    raw: string,
    lines: string[],
    at: number,
    data: Json,
    usage: Json | undefined,
  ): string {
    if (!fixUsage(usage, this.usage)) return raw
    const cr = lines[at].endsWith("\r") ? "\r" : ""
    lines[at] = `data: ${JSON.stringify(data)}${cr}`
    return lines.join("\n")
  }
}

/** The same filter for a non-streaming response body. */
export function filterMessage(message: Json): AdvisorUsage {
  const usage = emptyUsage()
  if (Array.isArray(message.content))
    message.content = message.content.filter((b: Json) => !isAdvisorBlock(b))
  fixUsage(message.usage, usage)
  return usage
}

/** Wraps a streaming body; `done` receives the advisor's usage when the stream ends. */
export function filterStream(
  body: ReadableStream<Uint8Array>,
  done: (usage: AdvisorUsage) => void,
): ReadableStream<Uint8Array> {
  const filter = new StreamFilter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const out = filter.push(decoder.decode(chunk, { stream: true }))
        if (out) controller.enqueue(encoder.encode(out))
      },
      flush(controller) {
        const out = filter.push(decoder.decode()) + filter.end()
        if (out) controller.enqueue(encoder.encode(out))
        done(filter.usage)
      },
    }),
  )
}
