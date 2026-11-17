// Stands in for a plugin that owns the Messages request path: a loopback proxy in
// front of the provider that runs the registered request and response hooks, as
// the hook contract describes. Test only; not shipped.
import { createServer } from "node:http"

const readBody = (req) =>
  new Promise((done) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")))
  })

async function startProxy(upstream, port) {
  const hooks = (globalThis.__claudeAccountsHooks ??= {
    before: [],
    response: [],
  })
  const server = createServer(async (incoming, out) => {
    const raw = await readBody(incoming)
    const headers = new Headers()
    for (const [k, v] of Object.entries(incoming.headers))
      if (!["host", "content-length", "connection"].includes(k))
        headers.set(k, String(v))
    const url = `${upstream}${incoming.url}`
    let body
    try {
      body = JSON.parse(raw)
    } catch {}
    const send = (b) =>
      fetch(url, {
        method: incoming.method,
        headers,
        body: b === undefined ? undefined : JSON.stringify(b),
      })
    let res
    if (body === undefined || !/\/messages/.test(incoming.url)) {
      res = await send(body)
    } else {
      const req = {
        url,
        body,
        headers,
        model: body.model,
        agent:
          raw.includes("ADVISED") && body.tools?.length
            ? "smoke-primary"
            : undefined,
        sessionID: headers.get("x-session-affinity") ?? "ses_stub",
      }
      for (const hook of hooks.before) await hook(req)
      res = await send(req.body)
      if (!process.env.STUB_SKIP_RESPONSE_HOOKS)
        for (const hook of hooks.response)
          res = await hook(res, { ...req, resend: send })
    }
    const outHeaders = {}
    res.headers.forEach((v, k) => {
      if (
        !["content-length", "content-encoding", "transfer-encoding"].includes(k)
      )
        outHeaders[k] = v
    })
    out.writeHead(res.status, outHeaders)
    if (!res.body) return out.end()
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(value)
    }
    out.end()
  })
  await new Promise((r) => server.listen(port, "127.0.0.1", r))
  server.unref()
}

export default {
  id: "request-hooks-stub",
  async setup() {
    const { STUB_UPSTREAM: upstream, STUB_PORT: port } = process.env
    if (upstream && port) await startProxy(upstream, Number(port))
  },
}
