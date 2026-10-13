import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { utils } from "ethers"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockEvm, MULTICALL3 } from "../support/evm"
import { evmAddress, makeTag } from "../support/fixtures"
import { findChainConfig } from "../../src/utils/chains"

// The detector against MockEvm (contract stubs + Multicall3), one mock node per
// chain: chains.ts points at it and the public fallbacks are dropped, so every
// attempt reaches the mock (retry delays are 1 ms in the test baseline).
const pm = require("../../src/utils/prediction-market-detection") as typeof import("../../src/utils/prediction-market-detection")

const abi = new utils.Interface([
  "function multiToken() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function getOutcomeSlotCount(bytes32) view returns (uint256)",
  "function allMarkets() view returns (address[])",
  "function numOutcomes() view returns (uint256)",
  "function wrappedOutcome(uint256) view returns (address, bytes)",
  "function market() view returns (address)",
  "function isKnownMarket(address) view returns (bool)",
  "function owner() view returns (address)",
  "function marketManager() view returns (address)",
  "function yesToken() view returns (address)",
  "function noToken() view returns (address)",
])
const REVERT = { code: 3, message: "execution reverted" }
// A contract stub answering the given functions; everything else reverts.
const stub = (answers: { [fn: string]: (args: utils.Result) => unknown[] }) => (data: string) => {
  const fn = Object.keys(answers).find((name) => data.startsWith(abi.getSighash(name)))
  if (!fn) throw REVERT
  return abi.encodeFunctionResult(fn, answers[fn](abi.decodeFunctionData(fn, data)))
}

let logs: CapturedConsole
const nodes: MockEvm[] = []
const node = async (chainId: string, opts: { multicall?: boolean } = {}): Promise<MockEvm> => {
  const evm = await new MockEvm({ chainId: Number(chainId) }).start()
  if (opts.multicall !== false) evm.code.set(MULTICALL3, "0x6080")
  findChainConfig(chainId)!.rpc = evm.url
  pm.FALLBACK_RPCS[chainId] = []
  nodes.push(evm)
  return evm
}
before(() => {
  logs = captureConsole()
})
after(async () => {
  logs.restore()
  for (const evm of nodes) await evm.stop()
})

const CTF = evmAddress(0xc7f)
const ctfStub = stub({ supportsInterface: ([id]) => [id === "0xd9b67a26"], getOutcomeSlotCount: () => [0] })
const wrapped = (multiToken: string) => stub({ multiToken: () => [multiToken], tokenId: () => [42] })
const token = (chain: string, address: string) => makeTag({ registry: "tokens", chain, tagAddress: address })

describe("prediction-market detection", () => {
  it("generic probe: a Wrapped1155 CTF position is caught, a plain token and a non-CTF 1155 wrapper are not", async () => {
    const evm = await node("43114")
    const position = evmAddress(0x5001)
    const decoy1155 = evmAddress(0x1155)
    const decoy = evmAddress(0x5002)
    evm.contracts.set(CTF, ctfStub)
    evm.contracts.set(position, wrapped(CTF))
    evm.contracts.set(decoy1155, stub({ supportsInterface: () => [true] }))
    evm.contracts.set(decoy, wrapped(decoy1155))
    const tags = [token("43114", position), token("43114", evmAddress(0x5003)), token("43114", decoy)]
    const matches = await pm.detectPredictionMarketTokens(tags)
    assert.deepEqual(Object.keys(matches), [tags[0].id])
    assert.equal(matches[tags[0].id].protocol, "conditional-tokens")
    assert.match(matches[tags[0].id].detail, /tokenId 42/)
  })

  it("Seer: names the market and outcome, on top of the generic hit", async () => {
    const evm = await node("100")
    const market = evmAddress(0x3a1)
    const outcome = evmAddress(0x3a2)
    for (const factory of pm.PREDICTION_MARKET_REGISTRIES["100"]) evm.contracts.set(factory.address.toLowerCase(), stub({ allMarkets: () => [[]] }))
    evm.contracts.set("0x83183da839ce8228e31ae41222ead9edbb5cdcf1", stub({ allMarkets: () => [[market]] }))
    evm.contracts.set(market, stub({ numOutcomes: () => [2], wrappedOutcome: ([i]) => [i.eq(1) ? outcome : evmAddress(0x3a9), "0x"] }))
    evm.contracts.set(CTF, ctfStub)
    evm.contracts.set(outcome, wrapped(CTF))
    const tag = token("100", outcome)
    const matches = await pm.detectPredictionMarketTokens([tag])
    assert.equal(matches[tag.id].protocol, "seer")
    assert.match(matches[tag.id].detail, new RegExp(`market ${market} outcome #1; also conditional-tokens`, "i"))
  })

  it("Overtime/Thales and Trueo: plain ERC-20 positions are matched through their manager", async () => {
    const evm = await node("8453")
    const thalesMarket = evmAddress(0x7a1)
    const thalesUp = evmAddress(0x7a2)
    const trueoMarket = evmAddress(0x7b1)
    const trueoYes = evmAddress(0x7b2)
    const lookalike = evmAddress(0x7c2) // owned by a "market" of another manager
    for (const r of pm.PREDICTION_MARKET_REGISTRIES["8453"]) {
      const address = r.address.toLowerCase()
      if (r.kind === "seer-market-factory") evm.contracts.set(address, stub({ allMarkets: () => [[]] }))
      if (r.kind === "thales-market-manager") evm.contracts.set(address, stub({ isKnownMarket: ([m]) => [m.toLowerCase() === thalesMarket] }))
    }
    evm.contracts.set(thalesUp, stub({ market: () => [thalesMarket] }))
    evm.contracts.set(trueoYes, stub({ owner: () => [trueoMarket] }))
    evm.contracts.set(trueoMarket, stub({ marketManager: () => ["0x61A98Bef11867c69489B91f340fE545eEfc695d7"], yesToken: () => [trueoYes], noToken: () => [evmAddress(0x7b3)] }))
    evm.contracts.set(lookalike, stub({ owner: () => [evmAddress(0x7c1)] }))
    evm.contracts.set(evmAddress(0x7c1), stub({ marketManager: () => [evmAddress(0xbad)], yesToken: () => [lookalike], noToken: () => [evmAddress(0x7c3)] }))
    const tags = [token("8453", thalesUp), token("8453", trueoYes), token("8453", lookalike)]
    const matches = await pm.detectPredictionMarketTokens(tags)
    assert.equal(matches[tags[0].id].protocol, "overtime-thales")
    assert.equal(matches[tags[1].id].protocol, "trueo")
    assert.match(matches[tags[1].id].detail, /YES token/)
    assert.equal(matches[tags[2].id], undefined)
  })

  it("a revert is a definite 'no match' (one batch, no retry); other registries are never probed", async () => {
    const evm = await node("42220")
    const tags = [token("42220", evmAddress(0x6001)), makeTag({ registry: "addressTags", chain: "42220" })]
    assert.deepEqual(await pm.detectPredictionMarketTokens(tags), {})
    assert.equal(evm.calls.eth_call, 1)
  })

  it("rides out a transient RPC error, and works without Multicall3", async () => {
    const evm = await node("59144", { multicall: false })
    const position = evmAddress(0x8001)
    evm.contracts.set(CTF, ctfStub)
    evm.contracts.set(position, wrapped(CTF))
    evm.faults.failNext = { eth_call: 1 }
    const tag = token("59144", position)
    const matches = await pm.detectPredictionMarketTokens([tag, token("59144", evmAddress(0x8002))])
    assert.deepEqual(Object.keys(matches), [tag.id])
  })

  it("fails closed: an RPC that keeps failing stops the run", async () => {
    const evm = await node("999")
    evm.faults.failNext = { eth_chainId: 100, eth_getCode: 100, eth_call: 100 }
    await assert.rejects(pm.detectPredictionMarketTokens([token("999", evmAddress(0x9001))]), /aborting so no prediction-market token slips/)
    assert.equal(evm.calls.eth_chainId, 4, "4 attempts")
  })

  it("classifies reverts apart from transport errors", () => {
    const revert = { code: "CALL_EXCEPTION", error: { code: "SERVER_ERROR", error: { code: 3, message: "execution reverted" } } }
    const rateLimited = { code: "CALL_EXCEPTION", error: { code: "SERVER_ERROR", status: 429, message: "bad response" } }
    const timeout = { code: "TIMEOUT" }
    const gasCap = { code: "CALL_EXCEPTION", error: { code: "SERVER_ERROR", error: { code: -32000, message: "gas required exceeds allowance" } } }
    const badParams = { code: "SERVER_ERROR", error: { code: -32602, message: "invalid params" } }
    assert.equal(pm.classifyError(revert), "revert")
    assert.equal(pm.classifyError(rateLimited), "transport")
    assert.equal(pm.classifyError(timeout), "transport")
    assert.equal(pm.classifyError(gasCap), "transport")
    assert.equal(pm.classifyError(badParams), "other")
  })
})
