import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { SolanaRpcPool } from "../../src/utils/solana-rpc"
import { captureConsole, CapturedConsole } from "../support/console"
import { http, result, rpcError, scripted } from "../support/rpc-script"
import { newChain } from "../support/solana"

// The Solana RPC pool's retries wait 1 s, 2 s… between attempts (the
// production backoff), hence the slow tier.
let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("SolanaRpcPool: retries", () => {
  it("retries transient JSON-RPC errors and HTTP 5xx, then answers", async () => {
    const { server, answered } = await scripted([rpcError(-32005, "node is behind"), http(502, "bad gateway"), result(7)])
    const pool = new SolanaRpcPool([{ url: server.url, rps: 1000 }])
    assert.equal(await pool.call<number>("getSlot", []), 7)
    assert.equal(answered.length, 3)
    await server.close()
  })

  it("gives up after maxAttempts transient failures", async () => {
    const { server, answered } = await scripted([http(500), http(500), http(500)])
    const pool = new SolanaRpcPool([{ url: server.url, rps: 1000 }])
    await assert.rejects(pool.call("getSlot", [], { maxAttempts: 2 }), /getSlot: HTTP 500/)
    assert.equal(answered.length, 2)
    await server.close()
  })

  it("goes on at start when a URL is merely down", async () => {
    const chain = await newChain(2)
    chain.faults[1].status = 500
    await new SolanaRpcPool(chain.urls().map((url) => ({ url, rps: 400, inFlight: 16 }))).assertKeysAccepted()
    assert.ok(logs.has(/did not answer at start, continuing/))
    await chain.stop()
  })
})
