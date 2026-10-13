import { after, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { SolanaRpcError, SolanaRpcPool } from "../../src/utils/solana-rpc"
import { captureConsole, CapturedConsole } from "../support/console"
import { http, result, rpcError, scripted } from "../support/rpc-script"
import { MockChain, newChain } from "../support/solana"

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("SolanaRpcPool: answers and errors", () => {
  it("returns the result and says which URL answered", async () => {
    const { server } = await scripted([result(42)])
    const pool = new SolanaRpcPool([{ url: server.url, rps: 1000 }])
    let index = -1
    assert.equal(await pool.call<number>("getSlot", [], { onAnswer: (i) => (index = i) }), 42)
    assert.equal(index, 0)
    await server.close()
  })

  it("fails at once on an error that retrying cannot fix, with its code", async () => {
    const { server, answered } = await scripted([rpcError(-32602, "Invalid params")])
    const pool = new SolanaRpcPool([{ url: server.url, rps: 1000 }])
    await assert.rejects(pool.call("getBlock", [1]), (err: unknown) => {
      assert.ok(err instanceof SolanaRpcError)
      assert.equal(err.code, -32602)
      assert.match(err.message, /getBlock: Invalid params \(code -32602\)/)
      return true
    })
    assert.equal(answered.length, 1)
    await server.close()
  })

  it("reports a response too large as such (HTTP 413)", async () => {
    const { server } = await scripted([http(413)])
    const pool = new SolanaRpcPool([{ url: server.url, rps: 1000 }])
    await assert.rejects(pool.call("getProgramAccounts", []), (err: unknown) => err instanceof SolanaRpcError && err.kind === "too-large")
    await server.close()
  })

  it("never puts an API key in an error message", async () => {
    const { server } = await scripted([() => ({ status: 400, raw: "" })])
    const keyed = `${server.url}/v2/SuperSecretKey0123456789?api-key=AnotherSecret987654`
    const pool = new SolanaRpcPool([{ url: keyed, rps: 1000 }])
    await assert.rejects(pool.call("getSlot", []), (err: unknown) => {
      const text = String((err as Error).message)
      assert.ok(!text.includes("SuperSecretKey0123456789") && !text.includes("AnotherSecret987654"), text)
      return true
    })
    await server.close()
  })
})

describe("SolanaRpcPool: refusals and several URLs", () => {
  let chain: MockChain
  beforeEach(async () => {
    if (chain) await chain.stop()
    chain = await newChain(2)
  })
  after(() => chain.stop())
  const pool = (rps: number[] = [400, 400]) =>
    new SolanaRpcPool(chain.urls().map((url, i) => ({ url, rps: rps[i], inFlight: 16 })))

  it("takes one refused method (HTTP 403) off a URL, and the URL off after a second", async () => {
    const rpc = pool([400, 20]) // URL 1 slower: URL 0 gets the calls first
    chain.faults[0].forbid = new Set(["getProgramAccounts"])
    await rpc.call("getProgramAccounts", ["x", { filters: [{ memcmp: { offset: 0, bytes: "m" } }] }])
    assert.equal(chain.calls["getProgramAccounts@0"], 1)
    const before = chain.calls["getSlot@0"] || 0
    for (let i = 0; i < 20; i++) await rpc.call("getSlot", [])
    assert.ok((chain.calls["getSlot@0"] || 0) - before > 0, "URL 0 still serves other methods")
    await rpc.call("getProgramAccounts", ["x", { filters: [{ memcmp: { offset: 0, bytes: "m" } }] }])
    assert.equal(chain.calls["getProgramAccounts@0"], 1, "not asked for the refused method again")
    chain.faults[0].forbid = new Set(["getProgramAccounts", "getBlock"])
    await rpc.call("getBlock", [5, {}])
    const mid = chain.calls["getSlot@0"] || 0
    for (let i = 0; i < 10; i++) await rpc.call("getSlot", [])
    assert.equal((chain.calls["getSlot@0"] || 0) - mid, 0, "a second refused method disables the URL")
    assert.ok(logs.has(/Disabling 127\.0\.0\.1:\d+\/0: HTTP 403 on getProgramAccounts and getBlock/))
  })

  it("leaves a pinned getProgramAccounts refusal to the caller, so the next scan asks again", async () => {
    const rpc = pool()
    chain.faults[0].forbid = new Set(["getProgramAccounts"])
    for (let i = 0; i < 2; i++) await assert.rejects(rpc.call("getProgramAccounts", ["x", {}], { only: 0 }), /HTTP 403/)
    assert.equal(chain.calls["getProgramAccounts@0"], 2)
  })

  it("remembers a pinned refusal of any other method", async () => {
    const rpc = pool()
    chain.faults[0].forbid = new Set(["getSignatureStatuses"])
    for (let i = 0; i < 3; i++) await assert.rejects(rpc.call("getSignatureStatuses", [["x"], {}], { only: 0 }))
    assert.equal(chain.calls["getSignatureStatuses@0"], 1)
  })

  it("disables a URL that rejects its key (401/402) and carries on with the others", async () => {
    const rpc = pool()
    chain.faults[0].status = 401
    for (let i = 0; i < 5; i++) assert.equal(await rpc.call<number>("getSlot", []), chain.tip)
    assert.equal(chain.calls["getSlot@0"], 1, "one call was rejected, none went there after it")
    assert.equal(rpc.stats()[0].disabled, "HTTP 401")
  })

  it("stops at start when a URL refuses its key, naming it", async () => {
    chain.faults[1].status = 403
    await assert.rejects(pool().assertKeysAccepted(), /RPC URL\(s\) refused the request: 127\.0\.0\.1:\d+\/1 \(HTTP 403\)/)
  })

  it("throws when no URL serves a method any more", async () => {
    const rpc = pool()
    chain.faults[0].forbid = new Set(["getBlock"])
    chain.faults[1].forbid = new Set(["getBlock"])
    await assert.rejects(rpc.call("getBlock", [1, {}]), /no RPC URL serves getBlock/)
  })

  it("routes around rate-limited URLs and avoided ones", async () => {
    const rpc = pool()
    chain.faults[0].rateLimitAll = true
    for (let i = 0; i < 5; i++) await rpc.call("getSlot", [])
    assert.ok((chain.calls["getSlot@1"] || 0) >= 5)
    chain.faults[0].rateLimitAll = false
    const before0 = chain.calls["getSlot@0"] || 0
    for (let i = 0; i < 5; i++) await rpc.call("getSlot", [], { avoid: [0] })
    assert.equal(chain.calls["getSlot@0"] || 0, before0, "avoided while another URL serves")
  })
})
