import { MockReply, startMockServer } from "./http"

// A server answering JSON-RPC calls from a script: each entry answers one call.
export const scripted = async (script: ((method: string) => MockReply)[]) => {
  const answered: string[] = []
  const server = await startMockServer((req) => {
    const { id, method } = req.json
    answered.push(method)
    const next = script.shift()
    if (!next) return { body: { jsonrpc: "2.0", id, result: "default" } }
    const reply = next(method)
    if (reply.body && typeof reply.body === "object" && !("jsonrpc" in (reply.body as object))) {
      return { ...reply, body: { jsonrpc: "2.0", id, ...(reply.body as object) } }
    }
    return reply
  })
  return { server, answered }
}
export const result = (value: unknown) => () => ({ body: { result: value } })
export const rpcError = (code: number, message = "boom") => () => ({ body: { error: { code, message } } })
export const http = (status: number, raw = "") => () => ({ status, raw })

