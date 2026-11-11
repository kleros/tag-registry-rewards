import { randomBytes, timingSafeEqual } from "crypto"
import { readFileSync } from "fs"
import { createServer, IncomingMessage, Server } from "http"
import { join } from "path"
import { SendRefusedError } from "../send-routine"
import { envInt, errorMessage } from "../utils/runtime-helpers"
import { DisburseSession } from "./session"

// The disburse page's server, on 127.0.0.1 only. It serves the page and its
// scripts (static/, read from disk at start) and the API the page drives the
// session with (session.ts), and nothing else:
// - only requests addressed to this machine by name (Host 127.0.0.1 or
//   localhost at its port): a site that points its own domain at 127.0.0.1
//   (DNS rebinding) gets nothing;
// - the API only from the page itself: POST, JSON, the page's Origin, and the
//   session token in a custom header, which another site cannot send without
//   a CORS preflight this server never grants. The token is in the link the
//   terminal prints, after the "#": the browser never sends that part to any
//   server, and the page served carries no secret;
// - no framing, no caching, no sniffing, no referrer, no plugins, no forms.

export const disbursePagePort = (): number => envInt("DISBURSE_PAGE_PORT", 8767) || 8767

const STATIC = join(__dirname, "static")
const ASSETS: { [path: string]: { file: string; type: string } } = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/page.js": { file: "page.js", type: "text/javascript; charset=utf-8" },
  "/main.js": { file: "main.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
}
const MAX_BODY = 64 * 1024

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  // Scripts are left to the browser's defaults: a wallet extension may inject
  // its provider with a script tag, which a script-src rule could block.
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error("request too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

type Body = { [key: string]: unknown }
type Handler = (body: Body) => unknown

// What the page sends: text, lists of text, a row's number. Anything else in
// their place (an object where a hash goes…) reads as nothing, which the
// session refuses in its own words.
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : [])
const rowNumber = (value: unknown): number => (typeof value === "number" ? value : NaN)

export const createDisburseServer = (session: DisburseSession, opts: { token?: string } = {}): { server: Server; token: string } => {
  const token = opts.token || randomBytes(32).toString("hex")
  const assets = new Map<string, { body: Buffer; type: string }>()
  for (const [path, { file, type }] of Object.entries(ASSETS)) assets.set(path, { type, body: readFileSync(join(STATIC, file)) })
  // A Map, not an object: a path is only ever one of these, never a name every
  // object has ("constructor", "__proto__"…).
  const routes = new Map<string, Handler>([
    ["/api/overview", () => session.overview()],
    [
      "/api/check",
      (b) =>
        session.check({
          folder: text(b.folder),
          kinds: texts(b.kinds),
          account: text(b.account),
          unrelatedTxs: texts(b.unrelatedTxs),
          skipPaidOnChain: b.skipPaidOnChain === true,
          paidTxs: texts(b.paidTxs),
          mode: text(b.mode),
        }),
    ],
    ["/api/next", (b) => session.next({ checkId: text(b.checkId) })],
    ["/api/next-batch", (b) => session.nextBatch({ checkId: text(b.checkId) })],
    ["/api/sent", (b) => session.sent({ requestId: text(b.requestId), hash: text(b.hash) })],
    ["/api/receipt", (b) => session.receipt({ requestId: text(b.requestId) })],
    ["/api/rejected", (b) => session.rejected({ requestId: text(b.requestId) })],
    ["/api/failed", (b) => session.failed({ requestId: text(b.requestId), message: text(b.message) })],
    ["/api/record-hash", (b) => session.recordHash({ recordId: text(b.recordId), index: rowNumber(b.index), hash: text(b.hash) })],
    ["/api/forget", (b) => session.forget({ recordId: text(b.recordId), index: rowNumber(b.index) })],
  ])
  // One API call at a time: the session is a sequence, never concurrent.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = (job: () => unknown): Promise<unknown> => {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  const server = createServer((request, response) => {
    const address = server.address()
    const port = address && typeof address === "object" ? address.port : 0
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`]
    const path = String(request.url || "").split("?")[0]
    const deny = (status = 404) => response.writeHead(status, SECURITY_HEADERS).end()
    if (!origins.includes(String(request.headers.host || ""))) return deny()

    if (request.method === "GET" || request.method === "HEAD") {
      const asset = assets.get(path)
      if (!asset) return deny()
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type })
      return response.end(request.method === "HEAD" ? undefined : asset.body)
    }
    const handler = routes.get(path)
    if (request.method !== "POST" || !handler) return deny()
    const origin = String(request.headers.origin || "")
    if (!origins.some((o) => origin === `http://${o}`)) return deny(403)
    if (!sameSecret(String(request.headers["x-disburse-session"] || ""), token)) return deny(403)
    if (!/^application\/json\b/i.test(String(request.headers["content-type"] || ""))) return deny(415)

    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(payload))
    }
    readBody(request)
      .then((sent) => {
        let body: unknown
        try {
          body = sent ? JSON.parse(sent) : {}
        } catch {
          throw new SendRefusedError("The request is not JSON")
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new SendRefusedError("The request is not a JSON object")
        return serialized(() => handler(body as Body))
      })
      .then(
        (result) => reply(200, { ok: true, result }),
        (err) => reply(200, { ok: false, refused: err instanceof SendRefusedError, error: errorMessage(err) })
      )
  })
  return { server, token }
}
