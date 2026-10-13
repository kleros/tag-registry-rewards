import * as http from "http"
import { AddressInfo } from "net"

// A local HTTP server answering with JSON, recording every request.
export interface MockRequest {
  method: string
  url: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: string
  json?: any
}

export interface MockReply {
  status?: number
  headers?: { [header: string]: string }
  body?: unknown // sent as JSON
  raw?: string // sent as is
  delayMs?: number
}

export interface MockServer {
  url: string
  port: number
  requests: MockRequest[]
  close(): Promise<void>
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const startMockServer = async (
  handle: (req: MockRequest) => MockReply | Promise<MockReply>
): Promise<MockServer> => {
  const requests: MockRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", async () => {
      const parsed = new URL(req.url || "/", "http://127.0.0.1")
      const entry: MockRequest = {
        method: req.method || "GET",
        url: req.url || "/",
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body,
      }
      try {
        entry.json = body ? JSON.parse(body) : undefined
      } catch {
        // not JSON
      }
      requests.push(entry)
      let reply: MockReply
      try {
        reply = await handle(entry)
      } catch (err) {
        reply = { status: 500, body: { error: String((err as Error).message) } }
      }
      if (reply.delayMs) await sleep(reply.delayMs)
      const payload = reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body === undefined ? null : reply.body)
      res.writeHead(reply.status || 200, { "Content-Type": "application/json", ...(reply.headers || {}) })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  // A server left open must not keep the test process alive (Node 20.18's
  // --test-force-exit ends test files early, so it is not used).
  server.unref()
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections
        if (closeAll) closeAll.call(server)
        server.close(() => resolve())
      }),
  }
}
