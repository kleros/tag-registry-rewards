import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { getAddressTagExclusionReason } from "../../src/utils/address-tag-validation"
import { ChainConfig, Tag } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockEvm } from "../support/evm"
import { evmAddress, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

// applyTagFilters' collaborators are swapped through their modules' exports
// (CommonJS reads them at call time): the explorer scraper (disabled in some
// local runs), the RPC validation and the pauses between checks.
const validation = require("../../src/utils/address-tag-validation")
const explorer = require("../../src/utils/is-tagged-on-etherscan")
const sender = require("../../src/transaction-sender")
const { applyTagFilters } = require("../../src/utils/tag-filters") as typeof import("../../src/utils/tag-filters")

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("address tag validation (eth_getCode, EIP-1167, ERC-165)", () => {
  let evm: MockEvm
  let chain: ChainConfig
  beforeEach(async () => {
    evm = await new MockEvm({ chainId: 1 }).start()
    chain = { id: "1", namespaceId: "eip155", name: "Ethereum", label: "ETH", explorer: "etherscan.io", rpc: evm.url }
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

  it("keeps the tag when the RPC fails (current behaviour: the check is best effort)", async () => {
    const down: ChainConfig = { ...chain, rpc: "http://127.0.0.1:9/down" }
    assert.equal(await getAddressTagExclusionReason(makeTag(), down), null)
  })
})

describe("applyTagFilters", () => {
  const checked: string[] = []
  let originals: { [k: string]: unknown }
  beforeEach(() => {
    checked.length = 0
    originals = {
      reason: validation.getAddressTagExclusionReason,
      explorer: explorer.isTaggedOnEtherscan,
      sleep: sender.sleep,
    }
    validation.getAddressTagExclusionReason = async (tag: Tag) => {
      checked.push(tag.tagAddress)
      return tag.tagAddress === evmAddress(0xe0a) ? "not a contract (getCode == 0x)" : null
    }
    explorer.isTaggedOnEtherscan = async () => false
    sender.sleep = async () => undefined
  })
  afterEach(() => {
    validation.getAddressTagExclusionReason = originals.reason
    explorer.isTaggedOnEtherscan = originals.explorer
    sender.sleep = originals.sleep
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

  it("checks many tags of one chain in batches", async () => {
    const tags = Array.from({ length: 12 }, (_, i) => makeTag({ chain: "137", tagAddress: evmAddress(0x9000 + i) }))
    const { passed } = await applyTagFilters(tags, 5)
    assert.equal(passed.length, 12)
    assert.equal(checked.length, 12)
  })
})

describe("explorer name-tag scraper", () => {
  const FETCH = require.resolve("node-fetch")
  const SCRAPER = require.resolve("../../src/utils/is-tagged-on-etherscan")
  let pages: { [url: string]: string | Error }
  let requested: string[]
  beforeEach(() => {
    pages = {}
    requested = []
    const fakeFetch = async (url: string) => {
      requested.push(url)
      const page = pages[url]
      if (page instanceof Error) throw page
      return { text: async () => page || "<html></html>" }
    }
    require.cache[FETCH] = { id: FETCH, filename: FETCH, loaded: true, exports: fakeFetch } as unknown as NodeModule
    delete require.cache[SCRAPER]
  })
  afterEach(() => {
    delete require.cache[FETCH]
    delete require.cache[SCRAPER]
  })
  const scraper = () => require(SCRAPER).isTaggedOnEtherscan as (host: string, address: string) => Promise<boolean>

  it("finds an Etherscan-style public name tag", async () => {
    const address = evmAddress(0xabc)
    pages[`https://etherscan.io/address/${address}`] = `<div><span class="hash-tag text-truncate lh-sm my-n1">Uniswap V3: Router</span></div>`
    assert.equal(await scraper()("etherscan.io", address), true)
    assert.equal(await scraper()("basescan.org", address), false)
    assert.deepEqual(requested, [`https://etherscan.io/address/${address}`, `https://basescan.org/address/${address}`])
  })

  it("uses Arbiscan's own markup", async () => {
    const address = evmAddress(0xdef)
    pages[`https://arbiscan.io/address/${address}`] = `<span title='Public Name Tag (viewable by anyone)'>GMX: Vault</span>`
    assert.equal(await scraper()("arbiscan.io", address), true)
  })

  it("answers false when the page cannot be fetched", async () => {
    const address = evmAddress(0x1)
    pages[`https://etherscan.io/address/${address}`] = new Error("ECONNRESET")
    assert.equal(await scraper()("etherscan.io", address), false)
  })
})
