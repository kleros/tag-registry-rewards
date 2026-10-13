import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { getAddressTagExclusionReason } from "../../src/utils/address-tag-validation"
import { ChainConfig, Tag } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockEvm } from "../support/evm"
import { withEnv } from "../support/env"
import { evmAddress, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

// applyTagFilters' collaborators are swapped through their modules' exports
// (CommonJS reads them at call time): the explorer check (off in the test
// baseline, EXPLORER_CHECK=off), the RPC validation and the pauses between checks.
const validation = require("../../src/utils/address-tag-validation")
const explorerTags = require("../../src/utils/explorer-tags")
const sender = require("../../src/transaction-sender")
const pm = require("../../src/utils/prediction-market-detection")
const { applyTagFilters } = require("../../src/utils/tag-filters") as typeof import("../../src/utils/tag-filters")

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("address tag validation (eth_getCode, EIP-1167, ERC-165)", () => {
  let evm: MockEvm
  let chain: ChainConfig
  // A chain id with no fallback RPCs of its own (the real chains' are public URLs)
  beforeEach(async () => {
    evm = await new MockEvm({ chainId: 31337 }).start()
    chain = { id: "31337", namespaceId: "eip155", name: "Testchain", label: "TEST", explorer: "etherscan.io", rpc: evm.url }
  })
  afterEach(() => evm.stop())
  const reason = (address: string) => getAddressTagExclusionReason(makeTag({ tagAddress: address }), chain)

  it("excludes an address without code (an EOA)", async () => {
    assert.equal(await reason(evmAddress(0x1)), "not a contract (getCode == 0x)")
  })

  it("excludes an EIP-1167 minimal proxy whose implementation has code", async () => {
    const impl = evmAddress(0x1111)
    const proxy = evmAddress(0x2222)
    evm.code.set(impl, "0x6080604052")
    evm.code.set(proxy, `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`)
    assert.equal(await reason(proxy), "eip-1167 minimal proxy")
    const orphan = evmAddress(0x3333)
    evm.code.set(orphan, `0x363d3d373d3d3d363d73${evmAddress(0x4444).slice(2)}5af43d82803e903d91602b57fd5bf3`)
    assert.equal(await reason(orphan), null, "a proxy to an empty address is kept")
  })

  it("excludes ERC-721 contracts and keeps others, with or without ERC-165", async () => {
    const nft = evmAddress(0x721)
    const erc165 = evmAddress(0x165)
    const plain = evmAddress(0x20)
    for (const a of [nft, erc165, plain]) evm.code.set(a, "0x6080")
    evm.interfaces.set(nft, true)
    evm.interfaces.set(erc165, false)
    assert.equal(await reason(nft), "erc-721 contract")
    assert.equal(await reason(erc165), null)
    assert.equal(await reason(plain), null, "supportsInterface reverting is normal")
  })

  it("never checks Solana addresses by bytecode", async () => {
    const solana: ChainConfig = { id: SOLANA_CHAIN, namespaceId: "solana", name: "Solana", label: "SOL", explorer: "solscan.io", rpc: evm.url }
    assert.equal(await getAddressTagExclusionReason(makeTag({ chain: SOLANA_CHAIN, tagAddress: solanaAddress("X") }), solana), null)
    assert.equal(evm.calls.eth_getCode || 0, 0)
  })

  it("stops, naming the chain's RPC, when it does not answer: an unchecked tag is never rewarded", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    try {
      const down: ChainConfig = { ...chain, rpc: "http://127.0.0.1:9/down" }
      await assert.rejects(
        getAddressTagExclusionReason(makeTag(), down),
        /Testchain \(31337\): no RPC answered eth_getCode for 0x[0-9a-f]{40} \(3 attempts on http:\/\/127\.0\.0\.1:9\/down.*rerun, and if it keeps failing, set a working RPC for it in src\/utils\/chains\.ts/s
      )
    } finally {
      sender.sleep = realSleep
    }
  })

  it("retries an RPC that fails now and then", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    try {
      evm.faults.failNext = { eth_getCode: 2 }
      assert.equal(await reason(evmAddress(0x1)), "not a contract (getCode == 0x)")
      assert.equal(evm.calls.eth_getCode, 3)
    } finally {
      sender.sleep = realSleep
    }
  })

  it("asks the chain's fallback RPCs when its own fails", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    const fallback = await new MockEvm({ chainId: 31337 }).start()
    pm.FALLBACK_RPCS["31337"] = [fallback.url]
    try {
      const contract = evmAddress(0xfa11)
      fallback.code.set(contract, "0x6080")
      fallback.interfaces.set(contract, true)
      const down: ChainConfig = { ...chain, rpc: "http://127.0.0.1:9/down" }
      assert.equal(await getAddressTagExclusionReason(makeTag({ tagAddress: contract }), down), "erc-721 contract")
    } finally {
      delete pm.FALLBACK_RPCS["31337"]
      sender.sleep = realSleep
      await fallback.stop()
    }
  })

  it("retries an ERC-165 call that failed in transit, never taking the failure for an answer", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    try {
      const nft = evmAddress(0x721)
      evm.code.set(nft, "0x6080")
      evm.interfaces.set(nft, true)
      evm.faults.failNext = { eth_call: 1 }
      assert.equal(await reason(nft), "erc-721 contract", "an NFT is not rewarded because of one HTTP 500")
      evm.faults.failNext = { eth_call: 10 }
      await assert.rejects(reason(nft), /no RPC answered supportsInterface for 0x[0-9a-f]{40}/)
    } finally {
      sender.sleep = realSleep
    }
  })

  it("keeps a contract whose ERC-165 call reverts or runs out of gas: no ERC-165", async () => {
    const greedy = evmAddress(0x9a5)
    evm.code.set(greedy, "0x6080")
    const realHandle = evm["handle"].bind(evm)
    evm["handle"] = (method: string, params: { to?: string }[]) => {
      if (method === "eth_call" && String(params[0].to).toLowerCase() === greedy) throw { code: -32000, message: "out of gas" }
      return realHandle(method, params)
    }
    assert.equal(await reason(greedy), null)
    assert.equal(evm.calls.eth_call, 1, "answered at once, not retried")
  })

  it("checks the address whatever the letter case it was registered in, and holds no contract at a non-address", async () => {
    const contract = evmAddress(0xc0de)
    evm.code.set(contract, "0x6080")
    const badChecksum = contract.slice(0, 2) + contract.slice(2).split("").map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("")
    assert.equal(await reason(badChecksum), null)
    assert.equal(await reason("0x1234"), "not a contract (getCode == 0x)")
  })
})

describe("applyTagFilters", () => {
  const checked: string[] = []
  const probed: Tag[][] = []
  let pmMatches: { [id: string]: { protocol: string; detail: string } } = {}
  let originals: { [k: string]: unknown }
  beforeEach(() => {
    checked.length = 0
    originals = {
      reason: validation.getAddressTagExclusionReason,
      explorer: explorerTags.checkExplorerTags,
      sleep: sender.sleep,
      pm: pm.detectPredictionMarketTokens,
    }
    probed.length = 0
    pmMatches = {}
    pm.detectPredictionMarketTokens = async (tags: Tag[]) => {
      probed.push(tags)
      return pmMatches
    }
    validation.getAddressTagExclusionReason = async (tag: Tag) => {
      checked.push(tag.tagAddress)
      return tag.tagAddress === evmAddress(0xe0a) ? "not a contract (getCode == 0x)" : null
    }
    explorerTags.checkExplorerTags = async () => {
      throw new Error("the explorer check is off")
    }
    sender.sleep = async () => undefined
  })
  afterEach(() => {
    validation.getAddressTagExclusionReason = originals.reason
    explorerTags.checkExplorerTags = originals.explorer
    sender.sleep = originals.sleep
    pm.detectPredictionMarketTokens = originals.pm
  })

  it("keeps rewardable tags and says why each other one is excluded", async () => {
    const ok = makeTag({ chain: "1", tagAddress: evmAddress(0xc1) })
    const eoa = makeTag({ chain: "8453", tagAddress: evmAddress(0xe0a) })
    const unrewardedChain = makeTag({ chain: "56" })
    const tokenName = makeTag({ isTokenOnAddressTags: true })
    const token = makeTag({ registry: "tokens", chain: "1" })
    const domain = makeTag({ registry: "domains", chain: "10" })
    const solanaTag = makeTag({ chain: SOLANA_CHAIN, tagAddress: solanaAddress("Prog") })
    const { passed, excluded } = await applyTagFilters([ok, eoa, unrewardedChain, tokenName, token, domain, solanaTag])
    assert.deepEqual(new Set(passed.map((t) => t.id)), new Set([ok, token, domain, solanaTag].map((t) => t.id)))
    assert.deepEqual(
      excluded.map((e) => [e.tag.id, e.reason]),
      [
        [unrewardedChain.id, "chain not configured for rewards"],
        [tokenName.id, "token on address tags"],
        [eoa.id, "not a contract (getCode == 0x)"],
      ]
    )
    assert.deepEqual(checked.sort(), [ok.tagAddress, eoa.tagAddress, solanaTag.tagAddress].sort(), "only Address Tags are checked on-chain")
  })

  const OCTOBER = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") }
  const SEPTEMBER = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") }

  it("drops prediction-market outcome tokens with the market as detail, and only probes token tags", async () => {
    const seer = makeTag({ registry: "tokens", chain: "100", tagAddress: evmAddress(0x5ee7) })
    const plain = makeTag({ registry: "tokens", chain: "100", tagAddress: evmAddress(0x20) })
    const addressTag = makeTag({ chain: "100", tagAddress: evmAddress(0xc1) })
    pmMatches = { [seer.id]: { protocol: "seer", detail: "Seer MarketFactory market 0xm outcome #1" } }
    const { passed, excluded } = await applyTagFilters([seer, plain, addressTag], { period: OCTOBER })
    assert.deepEqual(probed.map((batch) => batch.map((t) => t.id)), [[seer.id, plain.id]])
    assert.deepEqual(excluded.map((e) => [e.tag.id, e.reason, e.detail]), [[seer.id, "prediction market outcome token", "seer: Seer MarketFactory market 0xm outcome #1"]])
    assert.deepEqual(new Set(passed.map((t) => t.id)), new Set([plain.id, addressTag.id]))
  })

  it("lets a detection failure stop the run (fail closed)", async () => {
    pm.detectPredictionMarketTokens = async () => {
      throw new Error("[pm-detect] rpc down")
    }
    await assert.rejects(applyTagFilters([makeTag({ registry: "tokens", chain: "100" })], { period: OCTOBER }), /rpc down/)
  })

  it("leaves periods before the rule (2026-10-01) alone, and refuses a bad start date at load", async () => {
    const token = makeTag({ registry: "tokens", chain: "100" })
    pmMatches = { [token.id]: { protocol: "seer", detail: "x" } }
    const { passed } = await applyTagFilters([token], { period: SEPTEMBER })
    assert.deepEqual(passed.map((t) => t.id), [token.id])
    assert.equal(probed.length, 0, "not even probed")
    const MODULE = require.resolve("../../src/utils/tag-filters")
    for (const bad of ["2026-10", "2026-02-30"]) {
      delete require.cache[MODULE]
      await withEnv({ PREDICTION_MARKET_FILTER_SINCE: bad }, () => assert.throws(() => require(MODULE), /Invalid PREDICTION_MARKET_FILTER_SINCE/))
    }
    delete require.cache[MODULE]
    await withEnv({ PREDICTION_MARKET_FILTER_SINCE: "2026-09-01" }, async () => {
      const reloaded = require(MODULE) as typeof import("../../src/utils/tag-filters")
      const { excluded } = await reloaded.applyTagFilters([token], { period: SEPTEMBER })
      assert.deepEqual(excluded.map((e) => e.reason), ["prediction market outcome token"])
    })
    delete require.cache[MODULE]
  })

  it("checks many tags of one chain in batches", async () => {
    const tags = Array.from({ length: 12 }, (_, i) => makeTag({ chain: "137", tagAddress: evmAddress(0x9000 + i) }))
    const { passed } = await applyTagFilters(tags, { rpcConcurrency: 5 })
    assert.equal(passed.length, 12)
    assert.equal(checked.length, 12)
  })

  describe("on the chain's reference explorer", () => {
    let asked: { host: string; address: string }[]
    beforeEach(() => {
      asked = []
      process.env.EXPLORER_CHECK = "on"
      // tagged on etherscan.io: evmAddress(0x7a9); arbiscan.io cannot be read
      explorerTags.checkExplorerTags = async (items: { key: string; host: string; address: string }[]) => {
        asked.push(...items.map(({ host, address }) => ({ host, address })))
        return new Map(
          items.map((i) => [
            i.key,
            i.host === "arbiscan.io"
              ? { tagged: null, names: [], ignored: [], detail: "arbiscan.io shuts scripts out", url: `https://arbiscan.io/address/${i.address}` }
              : { tagged: i.address === evmAddress(0x7a9), names: ["Uniswap V2: Router 2"], ignored: [], detail: "", url: "" },
          ])
        )
      }
    })
    afterEach(() => {
      process.env.EXPLORER_CHECK = "off"
    })

    it("reports Address Tags and Tokens entries tagged there or not readable, excludes none, and never asks for CDN entries", async () => {
      const tagged = makeTag({ chain: "1", tagAddress: evmAddress(0x7a9) })
      const taggedToken = makeTag({ registry: "tokens", chain: "1", tagAddress: evmAddress(0x7a9) })
      const untagged = makeTag({ chain: "1", tagAddress: evmAddress(0xc1) })
      const onArbitrum = makeTag({ registry: "tokens", chain: "42161", tagAddress: evmAddress(0xa4b) })
      const domain = makeTag({ registry: "domains", chain: "1", tagAddress: evmAddress(0xd0) })
      const eoa = makeTag({ chain: "1", tagAddress: evmAddress(0xe0a) })
      const { passed, excluded, explorerReview } = await applyTagFilters([tagged, taggedToken, untagged, onArbitrum, domain, eoa])
      assert.equal(passed.length, 5, "a tag seen today may postdate the submission: a person decides")
      assert.deepEqual(excluded.map((e) => e.reason), ["not a contract (getCode == 0x)"])
      assert.ok(!asked.some((a) => a.address === eoa.tagAddress), "an entry already excluded needs no review")
      assert.deepEqual(
        explorerReview.map((r) => [r.tag.id, r.status, r.detail]),
        [
          [tagged.id, "tagged", "etherscan.io: Uniswap V2: Router 2"],
          [taggedToken.id, "tagged", "etherscan.io: Uniswap V2: Router 2"],
          [onArbitrum.id, "not read", "arbiscan.io shuts scripts out"],
        ]
      )
      assert.equal(explorerReview[2].url, `https://arbiscan.io/address/${onArbitrum.tagAddress}`)
      assert.ok(!asked.some((a) => a.address === domain.tagAddress), "CDN entries are exempt")
      assert.equal(asked.length, 4)
      assert.ok(checked.includes(tagged.tagAddress), "an entry tagged there is still checked on-chain")
    })

    it("is skipped with EXPLORER_CHECK=off, and by prefetch", async () => {
      const tags = [makeTag({ chain: "1", tagAddress: evmAddress(0x7a9) })]
      process.env.EXPLORER_CHECK = "off"
      assert.equal((await applyTagFilters(tags)).passed.length, 1)
      process.env.EXPLORER_CHECK = "on"
      assert.equal((await applyTagFilters(tags, { skipExplorerCheck: true })).passed.length, 1)
      assert.equal(asked.length, 0)
    })
  })
})
