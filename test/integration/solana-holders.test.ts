import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { checkHolders, countDistinctOwners, enrichSolanaTagsWithRpc } from "../../src/utils/solana-rpc-enrichment"
import { SolanaRpcPool } from "../../src/utils/solana-rpc"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"
import { MockChain, newChain, slotsFor } from "../support/solana"

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

// 32-byte owners whose last byte (the bucket) cycles through 0..255.
const owner = (n: number): Buffer => {
  const b = Buffer.alloc(32)
  b.writeUInt32BE(n, 0)
  b[31] = n % 256
  return b
}

let chain: MockChain
let logs: CapturedConsole
let restoreEnv: () => void
const pool = () => new SolanaRpcPool(chain.urls().map((url) => ({ url, rps: 1000, inFlight: 16 })))

// A mint of `program` held by `holders` distinct owners (some owning two accounts).
const addMint = (label: string, holders: number, program = TOKEN_PROGRAM): string => {
  const mint = solanaAddress(label)
  chain.accounts[mint] = { owner: program }
  for (let i = 0; i < holders; i++) chain.tokenAccounts.push({ mint, owner: owner(i) })
  for (let i = 0; i < Math.min(holders, 10); i++) chain.tokenAccounts.push({ mint, owner: owner(i) }) // second accounts
  return mint
}

before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(async () => {
  chain = await newChain(2)
  chain.accounts[TOKEN_PROGRAM] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }
  chain.accounts[TOKEN_2022] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }
  restoreEnv = setEnv({ JUPITER_TOKENS_API_URL: chain.jupiterUrl, TX_COUNT_CACHE: "on" })
  logs.clear()
})
afterEach(async () => {
  restoreEnv()
  await chain.stop()
})

describe("Solana holders", () => {
  it("accepts Jupiter's holder count when it already reaches the threshold", async () => {
    const mint = addMint("Popular", 3)
    chain.jupiter[mint] = { holderCount: 9000, createdAt: "2026-01-01T00:00:00Z", tokenProgram: TOKEN_PROGRAM }
    const out = await checkHolders(pool(), [mint], 5000)
    assert.deepEqual(out[mint], { holders: 9000, source: "jupiter", createdAt: "2026-01-01T00:00:00Z" })
    assert.equal(chain.calls.getProgramAccounts || 0, 0, "no on-chain scan needed")
  })

  it("counts distinct owners on-chain (any balance) when Jupiter's count is low or missing", async () => {
    const low = addMint("Low", 40)
    const unknown = addMint("Unlisted", 7)
    chain.jupiter[low] = { holderCount: 12, tokenProgram: TOKEN_PROGRAM }
    const out = await checkHolders(pool(), [low, unknown], 5000)
    assert.deepEqual(out[low], { holders: 40, source: "onchain", createdAt: undefined })
    assert.equal(out[unknown].holders, 7)
    assert.ok(logs.has("[solana-holders] 2 mint(s): 0 passed on Jupiter's holder count, 2 checked on-chain, 2 below 5000 holders"))
  })

  it("gives 0 holders to an address that is not a token mint, or does not exist", async () => {
    const wallet = solanaAddress("AWallet")
    chain.accounts[wallet] = { owner: "11111111111111111111111111111111" }
    const missing = solanaAddress("Nothing")
    const out = await checkHolders(pool(), [wallet, missing], 5000)
    assert.equal(out[wallet].source, "not-a-mint")
    assert.equal(out[wallet].holders, 0)
    assert.equal(out[missing].source, "missing-mint")
  })

  it("stops when Jupiter names a token program this code does not know", async () => {
    const mint = addMint("Weird", 3)
    chain.jupiter[mint] = { holderCount: 1, tokenProgram: "SomeOtherTokenProgram111111111111111111111" }
    await assert.rejects(checkHolders(pool(), [mint], 5000), /Jupiter reports token programs this code does not know/)
  })

  it("stops when a token program constant is not an executable account on-chain", async () => {
    delete chain.accounts[TOKEN_2022]
    const mint = addMint("Any", 3)
    await assert.rejects(checkHolders(pool(), [mint], 5000), /token program constant\(s\) TokenzQd\S+ are not executable/)
  })

  it("counts in owner buckets when a mint has too many accounts for one answer", async () => {
    const mint = addMint("Huge", 600)
    for (const f of chain.faults) f.programAccountsTooLarge = true
    const full = await countDistinctOwners(pool(), mint, TOKEN_PROGRAM, 100000)
    assert.deepEqual(full, { owners: 600, complete: true })
    const partial = await countDistinctOwners(pool(), mint, TOKEN_PROGRAM, 50)
    assert.equal(partial.complete, false, "stops once the threshold is reached")
    assert.ok(partial.owners >= 50 && partial.owners < 600)
  })

  it("drops the tokenAccountState filter for a Token-2022 mint when a node does not know it", async () => {
    const mint = addMint("T22", 25, TOKEN_2022)
    for (const f of chain.faults) f.rejectTokenAccountState = true
    assert.deepEqual(await countDistinctOwners(pool(), mint, TOKEN_2022, 5000), { owners: 25, complete: true })
  })

  it("moves on to the next URL when one refuses the holder scan", async () => {
    const mint = addMint("Refused", 9)
    chain.faults[0].forbid = new Set(["getProgramAccounts"])
    assert.deepEqual(await countDistinctOwners(pool(), mint, TOKEN_PROGRAM, 5000), { owners: 9, complete: true })
    assert.ok(logs.has(/did not serve getProgramAccounts/))
  })
})

describe("Solana enrichment and the holder threshold", () => {
  it("counts only the Tokens mints with enough holders, and every other address", async () => {
    const popular = addMint("Big", 3)
    chain.jupiter[popular] = { holderCount: 7000, tokenProgram: TOKEN_PROGRAM }
    const small = addMint("Small", 3)
    const program = solanaAddress("Program")
    chain.addHistory(popular, slotsFor(1500, 1000000, 1900000, 0, 1))
    chain.addHistory(small, slotsFor(300, 1000000, 1900000, 0, 2))
    chain.addHistory(program, slotsFor(900, 1500000, 1900000, 0, 3))
    const tags = [
      makeTag({ registry: "tokens", chain: SOLANA_CHAIN, tagAddress: popular }),
      makeTag({ registry: "tokens", chain: SOLANA_CHAIN, tagAddress: small }),
      makeTag({ registry: "addressTags", chain: SOLANA_CHAIN, tagAddress: program }),
      makeTag({ registry: "addressTags", chain: SOLANA_CHAIN, tagAddress: "not-base58-0OIl" }),
    ]
    const res = await enrichSolanaTagsWithRpc(tags, { rpc: pool(), persist: false })
    const key = (registry: string, address: string) => `${SOLANA_CHAIN}:${registry}:${address}`
    assert.deepEqual(res.byKey[key("tokens", popular)], { txCount: chain.ok(popular).ok, totalHolders: 7000 })
    assert.deepEqual(res.byKey[key("tokens", small)], { txCount: 0, totalHolders: 3 })
    assert.deepEqual(res.byKey[key("addressTags", program)], { txCount: chain.ok(program).ok, totalHolders: null })
    assert.deepEqual(res.byKey[key("addressTags", "not-base58-0OIl")], { txCount: 0, totalHolders: null })
    const method = (address: string) => res.addresses.find((a) => a.address === address)!.method
    assert.equal(method(small), "skipped-holders")
    assert.equal(method("not-base58-0OIl"), "invalid")
    assert.equal(method(popular), "exact")
    assert.equal(chain.calls[`gsfa:${small}`] || 0, 0, "no transactions counted for a mint that is dropped anyway")
  })
})
