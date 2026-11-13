import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { getAddressTagExclusionReason } from "../../src/utils/address-tag-validation"
import { ChainConfig, Tag } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockEvm } from "../support/evm"
import { setEnv, withEnv } from "../support/env"
import { newChain } from "../support/solana"
import { evmAddress, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

// applyTagFilters' collaborators are swapped through their modules' exports
// (CommonJS reads them at call time): the explorer check (off in the test
// baseline, EXPLORER_CHECK=off) and its dating, the RPC validation and the
// pauses between checks.
const validation = require("../../src/utils/address-tag-validation")
const explorerTags = require("../../src/utils/explorer-tags")
const tagDating = require("../../src/utils/tag-dating")
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

  it("excludes ERC-20 contracts by the functions every ERC-20 has, whatever their name tag", async () => {
    const { utils } = require("ethers") as typeof import("ethers")
    const iface = new utils.Interface([
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ])
    // a stub answering the given functions, reverting on anything else
    const stub = (answers: { [fn: string]: string }) => (data: string) => {
      const fn = Object.keys(answers).find((f) => data.startsWith(iface.getSighash(f)))
      if (!fn) throw { code: 3, message: "execution reverted" }
      return answers[fn]
    }
    const full: { [fn: string]: string } = {
      totalSupply: iface.encodeFunctionResult("totalSupply", [1000]),
      balanceOf: iface.encodeFunctionResult("balanceOf", [0]),
      allowance: iface.encodeFunctionResult("allowance", [0]),
    }
    const token = evmAddress(0x2001)
    const withDecimals = evmAddress(0x2002)
    const noAllowance = evmAddress(0x2003)
    const fallback = evmAddress(0x2004)
    const catchAll = evmAddress(0x2005)
    for (const a of [token, withDecimals, noAllowance, fallback, catchAll]) evm.code.set(a, "0x6080")
    evm.contracts.set(token, stub(full)) // no decimals() nor symbol(): both optional in EIP-20
    evm.contracts.set(withDecimals, stub({ ...full, decimals: iface.encodeFunctionResult("decimals", [18]) }))
    const { allowance, ...rest } = full
    evm.contracts.set(noAllowance, stub(rest))
    evm.contracts.set(fallback, () => "0x") // a fallback function answering everything with nothing
    evm.contracts.set(catchAll, () => full.totalSupply) // answering everything with a number
    assert.equal(await reason(token), "erc-20 contract")
    assert.equal(await reason(withDecimals), "erc-20 contract")
    assert.equal(await reason(noAllowance), null)
    assert.equal(await reason(fallback), null)
    assert.equal(await reason(catchAll), "answers any call (catch-all)", "its answers prove nothing either way: excluded, for a look by hand")
  })

  it("takes a revert's data, which ethers hands back as the call's result, for no answer", async () => {
    const { utils } = require("ethers") as typeof import("ethers")
    const errorString = new utils.Interface(["function Error(string)"]).encodeFunctionData("Error", ["not supported"]) // 4 + 96 bytes
    const customError = new utils.Interface(["function Unauthorized(uint256)"]).encodeFunctionData("Unauthorized", [3]) // 4 + 32 bytes
    const oracle = evmAddress(0x2301)
    const messenger = evmAddress(0x2302)
    for (const a of [oracle, messenger]) evm.code.set(a, "0x6080")
    evm.contracts.set(oracle, () => errorString) // a fallback reverting with a reason, for every call
    evm.contracts.set(messenger, () => customError)
    assert.equal(await reason(oracle), null, "neither a catch-all nor an ERC-20")
    assert.equal(await reason(messenger), null)
  })

  it("asks the chain's other RPCs before keeping a contract on empty answers: an NFT, or no code at all, from a node that has not synced it", async () => {
    const nft = evmAddress(0x2401)
    const fresh = evmAddress(0x2402)
    const synced = await new MockEvm({ chainId: 31337 }).start()
    pm.FALLBACK_RPCS["31337"] = [synced.url]
    try {
      evm.code.set(nft, "0x6080")
      evm.contracts.set(nft, () => "0x") // the lagging node: every call empty
      synced.code.set(nft, "0x6080")
      synced.interfaces.set(nft, true)
      assert.equal(await reason(nft), "erc-721 contract")
      synced.code.set(fresh, "0x6080") // no code yet on the chain's own RPC
      assert.equal(await reason(fresh), null, "a contract, kept")
      assert.equal(await reason(evmAddress(0x2403)), "not a contract (getCode == 0x)", "no code anywhere: an EOA")
    } finally {
      delete pm.FALLBACK_RPCS["31337"]
      await synced.stop()
    }
  })

  it("takes reth's wording of a halted call (an unknown function, no fallback) for a revert, not for a failure", async () => {
    const old = evmAddress(0x2501)
    evm.code.set(old, "0x6080")
    const realHandle = evm["handle"].bind(evm)
    evm["handle"] = (method: string, params: { to?: string }[]) => {
      if (method === "eth_call" && String(params[0].to).toLowerCase() === old) throw { code: -32003, message: "EVM error: InvalidFEOpcode" }
      return realHandle(method, params)
    }
    assert.equal(await reason(old), null)
    assert.equal(evm.calls.eth_call, 3, "each answered at once, not retried")
  })

  it("excludes a token or an NFT given a fallback that answers any call, which would otherwise pass both interface checks", async () => {
    const { utils } = require("ethers") as typeof import("ethers")
    const iface = new utils.Interface(["function totalSupply() view returns (uint256)"])
    const word = iface.encodeFunctionResult("totalSupply", [0]) // what such a fallback returns for anything
    const token = evmAddress(0x2101)
    const nft = evmAddress(0x2102)
    for (const a of [token, nft]) evm.code.set(a, "0x6080")
    evm.contracts.set(token, () => word)
    evm.interfaces.set(nft, true) // a real supportsInterface…
    evm.contracts.set(nft, () => word) // …and a fallback answering the rest
    assert.equal(await reason(token), "answers any call (catch-all)")
    assert.equal(await reason(nft), "answers any call (catch-all)")
  })

  it("asks the chain's other RPCs before taking an empty answer for 'not a token': a node may not have synced the contract", async () => {
    const { utils } = require("ethers") as typeof import("ethers")
    const iface = new utils.Interface(["function totalSupply() view returns (uint256)"])
    const token = evmAddress(0x2201)
    const synced = await new MockEvm({ chainId: 31337 }).start()
    pm.FALLBACK_RPCS["31337"] = [synced.url]
    try {
      evm.code.set(token, "0x6080")
      evm.contracts.set(token, () => "0x") // the lagging node: no contract there yet
      synced.code.set(token, "0x6080")
      // a token there: totalSupply, balanceOf and allowance answer, anything else reverts
      synced.contracts.set(token, (data: string) => {
        if (!/^0x(18160ddd|70a08231|dd62ed3e)/.test(data)) throw { code: 3, message: "execution reverted" }
        return iface.encodeFunctionResult("totalSupply", [5])
      })
      assert.equal(await reason(token), "erc-20 contract")
      evm.contracts.set(token, () => "0x")
      synced.contracts.set(token, () => "0x")
      assert.equal(await reason(token), null, "empty everywhere: not a token")
    } finally {
      delete pm.FALLBACK_RPCS["31337"]
      await synced.stop()
    }
  })

  it("excludes a Solana token mint, Solana's ERC-20, and keeps programs, wallets and token accounts", async () => {
    const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    const sol = await newChain(1)
    const restore = setEnv({ SOLANA_RPC_URLS: sol.urls().join(",") })
    try {
      const mint = solanaAddress("Mint")
      const mint2022 = solanaAddress("Mint2022")
      const program = solanaAddress("Program")
      const tokenAccount = solanaAddress("Holder")
      const wallet = solanaAddress("Wallet")
      sol.accounts[mint] = { owner: TOKEN, data: Buffer.alloc(82) }
      const extended = Buffer.alloc(234)
      extended[165] = 1 // account type: mint, then its extensions
      sol.accounts[mint2022] = { owner: TOKEN_2022, data: extended }
      sol.accounts[program] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, data: Buffer.alloc(36) }
      sol.accounts[tokenAccount] = { owner: TOKEN, data: Buffer.alloc(165) }
      const solana: ChainConfig = { id: SOLANA_CHAIN, namespaceId: "solana", name: "Solana", label: "SOL", explorer: "solscan.io", rpc: evm.url }
      const check = (address: string) => getAddressTagExclusionReason(makeTag({ chain: SOLANA_CHAIN, tagAddress: address }), solana)
      assert.equal(await check(mint), "solana token mint")
      assert.equal(await check(mint2022), "solana token mint", "a Token-2022 mint with extensions")
      assert.equal(await check(program), null)
      assert.equal(await check(tokenAccount), null, "a holder's token account is no token")
      assert.equal(await check(wallet), null, "an account that does not exist")
      assert.equal(await check("not-base58-0OIl"), null)
      assert.equal(evm.calls.eth_getCode || 0, 0, "no EVM call for a Solana address")
    } finally {
      restore()
      await sol.stop()
    }
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

  it("never takes the answer of a fallback RPC that serves another chain", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    const wrongChain = await new MockEvm({ chainId: 1 }).start() // no code there: every address an EOA
    const fallback = await new MockEvm({ chainId: 31337 }).start()
    pm.FALLBACK_RPCS["31337"] = [wrongChain.url, fallback.url]
    try {
      const contract = evmAddress(0xc0de)
      fallback.code.set(contract, "0x6080")
      const down: ChainConfig = { ...chain, rpc: "http://127.0.0.1:9/down" }
      assert.equal(await getAddressTagExclusionReason(makeTag({ tagAddress: contract }), down), null, "a contract, not an EOA")
      assert.equal(wrongChain.calls.eth_getCode || 0, 0)
    } finally {
      delete pm.FALLBACK_RPCS["31337"]
      sender.sleep = realSleep
      await wrongChain.stop()
      await fallback.stop()
    }
  })

  it("retries an interface check that failed in transit, never taking the failure for an answer", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    try {
      const nft = evmAddress(0x721)
      evm.code.set(nft, "0x6080")
      evm.interfaces.set(nft, true)
      evm.faults.failNext = { eth_call: 1 }
      assert.equal(await reason(nft), "erc-721 contract", "an NFT is not rewarded because of one HTTP 500")
      evm.faults.failNext = { eth_call: 10 }
      await assert.rejects(reason(nft), /no RPC answered the interface checks of 0x[0-9a-f]{40}/, "the interface checks")
    } finally {
      sender.sleep = realSleep
    }
  })

  it("asks the fallback RPC when the chain's own refuses the ERC-165 call, never taking the refusal for an answer", async () => {
    const realSleep = sender.sleep
    sender.sleep = async () => undefined
    const fallback = await new MockEvm({ chainId: 31337 }).start()
    pm.FALLBACK_RPCS["31337"] = [fallback.url]
    try {
      const nft = evmAddress(0x721)
      for (const node of [evm, fallback]) node.code.set(nft, "0x6080")
      fallback.interfaces.set(nft, true)
      const realHandle = evm["handle"].bind(evm)
      evm["handle"] = (method: string, params: unknown[]) => {
        if (method === "eth_call") throw { code: -32602, message: "invalid argument 0: json: cannot unmarshal" }
        return realHandle(method, params)
      }
      assert.equal(await reason(nft), "erc-721 contract")
      assert.equal(fallback.calls.eth_call, 2, "the no-function control, then supportsInterface")
    } finally {
      delete pm.FALLBACK_RPCS["31337"]
      sender.sleep = realSleep
      await fallback.stop()
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
    assert.equal(evm.calls.eth_call, 3, "the no-function control, ERC-165, then the ERC-20 check's first call: each answered at once, not retried")
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
    type DatingItem = import("../../src/utils/tag-dating").DatingItem
    type DatingVerdict = import("../../src/utils/tag-dating").DatingVerdict
    let dated: DatingItem[]
    let verdictFor: (item: DatingItem) => DatingVerdict
    let realDating: unknown
    beforeEach(() => {
      asked = []
      dated = []
      process.env.EXPLORER_CHECK = "on"
      // tagged on etherscan.io: evmAddress(0x7a9), a token whose page shows its
      // logo and age; arbiscan.io cannot be read
      explorerTags.checkExplorerTags = async (items: { key: string; host: string; address: string }[]) => {
        asked.push(...items.map(({ host, address }) => ({ host, address })))
        return new Map(
          items.map((i) => [
            i.key,
            i.host === "arbiscan.io"
              ? { tagged: null, names: [], ignored: [], detail: "arbiscan.io shuts scripts out", url: `https://arbiscan.io/address/${i.address}` }
              : {
                  tagged: i.address === evmAddress(0x7a9),
                  names: ["Uniswap V2: Router 2"],
                  ignored: [],
                  detail: "",
                  url: "",
                  ...(i.address === evmAddress(0x7a9) ? { logo: "https://etherscan.io/token/images/uni_32.png" } : {}),
                },
          ])
        )
      }
      realDating = tagDating.dateExplorerTags
      verdictFor = () => ({ decision: "paid by default", evidence: "no dated evidence either way" })
      tagDating.dateExplorerTags = async (items: DatingItem[]) => {
        dated.push(...items)
        return new Map(items.map((i) => [i.key, verdictFor(i)]))
      }
    })
    afterEach(() => {
      process.env.EXPLORER_CHECK = "off"
      tagDating.dateExplorerTags = realDating
    })

    const NOVEMBER = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") }

    it("before November 2026, reports Address Tags and Tokens entries tagged there or not readable, excludes none, and never asks for CDN entries", async () => {
      const tagged = makeTag({ chain: "1", tagAddress: evmAddress(0x7a9) })
      const taggedToken = makeTag({ registry: "tokens", chain: "1", tagAddress: evmAddress(0x7a9) })
      const untagged = makeTag({ chain: "1", tagAddress: evmAddress(0xc1) })
      const onArbitrum = makeTag({ registry: "tokens", chain: "42161", tagAddress: evmAddress(0xa4b) })
      const domain = makeTag({ registry: "domains", chain: "1", tagAddress: evmAddress(0xd0) })
      const eoa = makeTag({ chain: "1", tagAddress: evmAddress(0xe0a) })
      const { passed, excluded, explorerReview } = await applyTagFilters([tagged, taggedToken, untagged, onArbitrum, domain, eoa], { period: OCTOBER })
      assert.equal(passed.length, 5, "a tag seen today may postdate the submission: a person decides")
      assert.deepEqual(excluded.map((e) => e.reason), ["not a contract (getCode == 0x)"])
      assert.equal(dated.length, 0, "October 2026 was paid before the dated check: re-running it reproduces that")
      assert.ok(explorerReview.every((r) => r.decision === undefined))
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

    it("from November 2026, excludes an entry with dated evidence of its tag before its submission, and gives every other its verdict", async () => {
      const tagged = makeTag({ chain: "1", tagAddress: evmAddress(0x7a9), submissionTime: 1793000000 })
      const taggedToken = makeTag({ registry: "tokens", chain: "1", tagAddress: evmAddress(0x7a9), submissionTime: 1793100000 })
      const untagged = makeTag({ chain: "1", tagAddress: evmAddress(0xc1), submissionTime: 1793000000 })
      const onArbitrum = makeTag({ registry: "tokens", chain: "42161", tagAddress: evmAddress(0xa4b), submissionTime: 1793200000 })
      const domain = makeTag({ registry: "domains", chain: "1", tagAddress: evmAddress(0x7a9), submissionTime: 1793000000 })
      verdictFor = (item) =>
        item.tagged === null
          ? { decision: "paid by default", evidence: "its explorer could not be read, with no dated evidence: the Wayback Machine did not answer (HTTP 503)" }
          : item.submissionTime === 1793000000
          ? { decision: "excluded", evidence: "archived with the public name tag \"Uniswap V2: Router 2\" on 2025-01-01T00:00:00Z, before the submission" }
          : { decision: "kept", evidence: "archived without a public name tag after the submission" }
      const { passed, excluded, explorerReview } = await applyTagFilters([tagged, taggedToken, untagged, onArbitrum, domain], { period: NOVEMBER })
      assert.deepEqual(
        excluded.map((e) => [e.tag.id, e.reason, e.detail]),
        [[tagged.id, "tagged on explorer before submission", "archived with the public name tag \"Uniswap V2: Router 2\" on 2025-01-01T00:00:00Z, before the submission"]]
      )
      assert.deepEqual(new Set(passed.map((t) => t.id)), new Set([taggedToken.id, untagged.id, onArbitrum.id, domain.id]), "a CDN entry is exempt, whatever its address")
      assert.deepEqual(
        dated.map(({ address, submissionTime, tagged, names, logo }) => ({ address, submissionTime, tagged, names, logo })),
        [
          { address: evmAddress(0x7a9), submissionTime: 1793000000, tagged: true, names: ["Uniswap V2: Router 2"], logo: "https://etherscan.io/token/images/uni_32.png" },
          { address: evmAddress(0x7a9), submissionTime: 1793100000, tagged: true, names: ["Uniswap V2: Router 2"], logo: "https://etherscan.io/token/images/uni_32.png" },
          { address: evmAddress(0xa4b), submissionTime: 1793200000, tagged: null, names: [], logo: undefined },
        ],
        "only entries tagged today or not readable are dated, each against its own submission"
      )
      assert.deepEqual(
        explorerReview.map((r) => [r.tag.id, r.status, r.decision]),
        [
          [tagged.id, "tagged", "excluded"],
          [taggedToken.id, "tagged", "kept"],
          [onArbitrum.id, "not read", "paid by default"],
        ]
      )
      assert.ok(logs.has("Explorer dating: 1 excluded on dated evidence of a tag before their submission, 1 kept on dated evidence, 1 paid without dated evidence either way"))
      assert.ok(
        logs.has("Explorer dating: 1 of them paid by default because the Wayback Machine, eth-labels or the registries did not answer"),
        "a later run may exclude it: the run says so"
      )
    })

    it("dates from EXPLORER_DATING_SINCE, read when a period is filtered, and refuses a bad one", async () => {
      const tags = [makeTag({ chain: "1", tagAddress: evmAddress(0x7a9), submissionTime: 1790000000 })]
      await withEnv({ EXPLORER_DATING_SINCE: "2026-10-01" }, () => applyTagFilters(tags, { period: OCTOBER }))
      assert.equal(dated.length, 1, "October dated when the setting says so")
      await withEnv({ EXPLORER_DATING_SINCE: "2026-12-01" }, () => applyTagFilters(tags, { period: NOVEMBER }))
      assert.equal(dated.length, 1, "November left alone when the setting starts later")
      assert.ok(logs.has("Explorer dating skipped: period starts 2026-11-01T00:00:00.000Z, before EXPLORER_DATING_SINCE=2026-12-01"))
      await withEnv({ EXPLORER_DATING_SINCE: "2026-13-01" }, () => assert.rejects(applyTagFilters(tags, { period: NOVEMBER }), /Invalid EXPLORER_DATING_SINCE "2026-13-01"/))
    })

    it("is skipped with EXPLORER_CHECK=off, and by prefetch", async () => {
      const tags = [makeTag({ chain: "1", tagAddress: evmAddress(0x7a9) })]
      process.env.EXPLORER_CHECK = "off"
      assert.equal((await applyTagFilters(tags)).passed.length, 1)
      process.env.EXPLORER_CHECK = "on"
      assert.equal((await applyTagFilters(tags, { skipExplorerCheck: true })).passed.length, 1)
      assert.equal(asked.length, 0)
      assert.equal(dated.length, 0)
    })
  })
})
