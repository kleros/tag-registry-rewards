import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils } from "ethers"
import { buildRewards } from "../../src/reward-builder"
import { generateContractInfos } from "../../src/contract-info"
import { GasDune, Reward, Tag } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { withEnv } from "../support/env"
import { evmAddress, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

const PNK = (n: number | string) => utils.parseEther(String(n))
const DEFAULT_FORMULA =
  "(reward_pool/(2*total_submissions)) + ((reward_pool*txns_with_contract)/(2*total_txns_with_all_contracts))"

// A tag and the matching row of the gas file (EVM addresses lowercase, no 0x).
const withCount = (tag: Tag, txCount: number): { tag: Tag; gas: GasDune } => ({
  tag,
  gas: {
    chain: tag.chain,
    address: tag.tagAddress.startsWith("0x") ? tag.tagAddress.toLowerCase().slice(2) : tag.tagAddress,
    tx_count: txCount,
  },
})

const build = (entries: { tag: Tag; gas: GasDune }[], stipend = PNK(1200), maxReward = PNK(1000000)) =>
  buildRewards(
    stipend,
    maxReward,
    entries.map((e) => e.tag),
    entries.map((e) => e.gas)
  )

const amountOf = (rewards: Reward[], tag: Tag): string => {
  const reward = rewards.find((r) => r.id === tag.id)
  assert.ok(reward, `no reward for ${tag.id}`)
  return utils.formatEther(reward.amount)
}

const sum = (rewards: Reward[]): BigNumber => rewards.reduce((acc, r) => acc.add(r.amount), BigNumber.from(0))

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("buildRewards: default formula", () => {
  const settings = {
    REWARD_FORMULA_ADDRESS_TAGS: DEFAULT_FORMULA,
    REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS: "true",
  }

  it("splits half the pool evenly and half by transaction count", async () => {
    const a = withCount(makeTag(), 100)
    const b = withCount(makeTag(), 200)
    const c = withCount(makeTag(), 300)
    const rewards = await withEnv(settings, () => build([a, b, c]))
    // 1200/6 = 200 each, plus 1200 * tx / 1200
    assert.deepEqual([amountOf(rewards, a.tag), amountOf(rewards, b.tag), amountOf(rewards, c.tag)], ["300.0", "400.0", "500.0"])
    assert.equal(sum(rewards).toString(), PNK(1200).toString())
    assert.deepEqual(
      rewards.map((r) => r.recipient),
      [a, b, c].map((e) => e.tag.submitter)
    )
  })

  it("caps rewards at MAX_REWARD and redistributes the excess recursively", async () => {
    const a = withCount(makeTag(), 100)
    const b = withCount(makeTag(), 200)
    const c = withCount(makeTag(), 300)
    const rewards = await withEnv(settings, () => build([a, b, c], PNK(1200), PNK(450)))
    // c (500) is capped at 450; the other 750 PNK is split again between a and b:
    // 750/4 + 750 * tx / 600 → a 312.5, b 437.5
    assert.equal(amountOf(rewards, c.tag), "450.0")
    assert.equal(amountOf(rewards, a.tag), "312.5")
    assert.equal(amountOf(rewards, b.tag), "437.5")
    assert.equal(sum(rewards).toString(), PNK(1200).toString(), "redistribution keeps the whole pool")
    assert.ok(rewards.every((r) => r.amount.lte(PNK(450))))
  })

  it("redistributes until nothing is above the cap, an equal split once no counts remain", async () => {
    const a = withCount(makeTag(), 0)
    const b = withCount(makeTag(), 100)
    const c = withCount(makeTag(), 300)
    const rewards = await withEnv(settings, () => build([a, b, c], PNK(1200), PNK(450)))
    // round 1: a 200, b 300, c 600 → c capped; round 2 (750 PNK): a 187.5, b 562.5 → b capped;
    // round 3: 300 PNK for a alone, whose count is 0 → equal split → 300
    assert.equal(amountOf(rewards, c.tag), "450.0")
    assert.equal(amountOf(rewards, b.tag), "450.0")
    assert.equal(amountOf(rewards, a.tag), "300.0")
  })

  it("caps without redistribution when REWARD_REDISTRIBUTE_CAPPED is false", async () => {
    const a = withCount(makeTag(), 100)
    const b = withCount(makeTag(), 200)
    const c = withCount(makeTag(), 300)
    const rewards = await withEnv({ ...settings, REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS: "false" }, () =>
      build([a, b, c], PNK(1200), PNK(450))
    )
    assert.deepEqual([amountOf(rewards, a.tag), amountOf(rewards, b.tag), amountOf(rewards, c.tag)], ["300.0", "400.0", "450.0"])
    assert.equal(sum(rewards).toString(), PNK(1150).toString(), "the capped excess stays unspent")
  })

  it("splits the pool evenly when no entry has a transaction (legacy behaviour)", async () => {
    const entries = [withCount(makeTag(), 0), withCount(makeTag(), 0), withCount(makeTag(), 0)]
    const rewards = await withEnv(settings, () => build(entries, PNK(1000)))
    assert.deepEqual(
      rewards.map((r) => r.amount.toString()),
      Array(3).fill(PNK(1000).div(3).toString())
    )
  })

  it("rewards a contract with no transactions found as a count of 0", async () => {
    const counted = withCount(makeTag(), 600)
    const missing = makeTag()
    const rewards = await withEnv(settings, () =>
      buildRewards(PNK(1200), PNK(1000000), [counted.tag, missing], [counted.gas])
    )
    assert.equal(amountOf(rewards, missing), "300.0") // 1200/4, nothing from the tx half
    assert.equal(amountOf(rewards, counted.tag), "900.0")
    assert.ok(logs.has(`Unable to find matched gasDune for tag ${missing.tagAddress}`))
  })
})

describe("buildRewards: registries", () => {
  it("gives every registry its own pool and formula", async () => {
    const tag = withCount(makeTag({ registry: "addressTags" }), 10)
    const token = withCount(makeTag({ registry: "tokens", chain: "100" }), 10)
    const domain = withCount(makeTag({ registry: "domains", chain: "137" }), 10)
    const rewards = await withEnv(
      {
        REWARD_FORMULA_ADDRESS_TAGS: "reward_pool",
        REWARD_FORMULA_TOKENS: "reward_pool/2",
        REWARD_FORMULA_DOMAINS: "reward_pool/4",
      },
      () => build([tag, token, domain], PNK(800))
    )
    assert.equal(amountOf(rewards, tag.tag), "800.0")
    assert.equal(amountOf(rewards, token.tag), "400.0")
    assert.equal(amountOf(rewards, domain.tag), "200.0")
  })

  it("ranks Tokens by the documented formula: half by count, half by square root of the count (from October 2026)", async () => {
    const entries = [1, 4, 9, 16].map((count) => withCount(makeTag({ registry: "tokens", chain: "100" }), count))
    const rewards = await build(entries, PNK(3000))
    // 50% of 3000 by count (total 30) + 50% by sqrt (total 10): 50*tx + 150*sqrt(tx)
    const expected = [200, 500, 900, 1400]
    entries.forEach((entry, i) => {
      const got = Number(amountOf(rewards, entry.tag))
      assert.ok(Math.abs(got - expected[i]) < 1e-9, `entry ${i}: ${got} vs ${expected[i]}`)
    })
    assert.ok(sum(rewards).lte(PNK(3000)))
  })

  it("ranks Tokens 10% by count and 90% by square root with the formula of September 2026 and before", async () => {
    const entries = [1, 4, 9, 16].map((count) => withCount(makeTag({ registry: "tokens", chain: "100" }), count))
    const formula =
      "((token_tx/total_txns_with_all_contracts)*0.1*reward_pool) + ((sqrt(token_tx)/sum_sqrt_total_txns_with_all_contracts)*0.9*reward_pool)"
    const rewards = await withEnv({ REWARD_FORMULA_TOKENS: formula }, () => build(entries, PNK(3000)))
    // 10% of 3000 by count (total 30) + 90% by sqrt (total 10): 10*tx + 270*sqrt(tx)
    const expected = [280, 580, 900, 1240]
    entries.forEach((entry, i) => {
      const got = Number(amountOf(rewards, entry.tag))
      assert.ok(Math.abs(got - expected[i]) < 1e-9, `entry ${i}: ${got} vs ${expected[i]}`)
    })
  })

  it("divides Solana counts by SOLANA_TX_DIVIDER before the formula, and only them", async () => {
    const evm = withCount(makeTag({ registry: "tokens", chain: "100" }), 4)
    const sol = withCount(
      makeTag({ registry: "tokens", chain: SOLANA_CHAIN, tagAddress: solanaAddress("Divided") }),
      4999 // floor(4999 / 1000) = 4: same weight as the EVM token
    )
    const rewards = await withEnv({ SOLANA_TX_DIVIDER: "1000" }, () => build([evm, sol], PNK(1000)))
    assert.equal(amountOf(rewards, evm.tag), amountOf(rewards, sol.tag))
    const undivided = await withEnv({ SOLANA_TX_DIVIDER: "1" }, () => build([evm, sol], PNK(1000)))
    assert.ok(Number(amountOf(undivided, sol.tag)) > Number(amountOf(undivided, evm.tag)))
  })

  it("never pays more than the pool: every registry total stays within it", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => withCount(makeTag({ registry: "tokens", chain: "100" }), i * i * 37 + 1))
    const rewards = await build(entries, PNK(93000), PNK(500))
    assert.ok(sum(rewards).lte(PNK(93000)))
    assert.ok(rewards.every((r) => r.amount.lte(PNK(500)) && !r.amount.isNegative()))
  })
})

describe("buildRewards: misconfiguration fails before any file is written", () => {
  it("rejects a formula that pays out more than the pool", async () => {
    const entries = [withCount(makeTag(), 1), withCount(makeTag(), 2)]
    await withEnv({ REWARD_FORMULA_ADDRESS_TAGS: "reward_pool" }, () =>
      assert.rejects(build(entries, PNK(100)), /Rewards for addressTags add up to 200\.0 PNK, more than its pool of 100\.0 PNK/)
    )
  })

  it("rejects an invalid formula, toggle or Solana divider", async () => {
    const entries = [withCount(makeTag(), 1)]
    await withEnv({ REWARD_FORMULA_TOKENS: "reward_pool +" }, () => assert.rejects(build(entries), /Invalid formula for tokens/))
    await withEnv({ REWARD_REDISTRIBUTE_CAPPED_DOMAINS: "yes" }, () =>
      assert.rejects(build(entries), /Invalid value for REWARD_REDISTRIBUTE_CAPPED_DOMAINS \(domains\): "yes"/)
    )
    await withEnv({ SOLANA_TX_DIVIDER: "0.5" }, () => assert.rejects(build(entries), /Invalid SOLANA_TX_DIVIDER="0.5"/))
    await withEnv({ SOLANA_TX_DIVIDER: "abc" }, () => assert.rejects(build(entries), /Invalid SOLANA_TX_DIVIDER/))
  })
})

describe("generateContractInfos: matching tags to tx counts", () => {
  it("matches EVM addresses case-insensitively, with or without 0x", () => {
    const tag = makeTag({ chain: "1", tagAddress: "0xAbCdEf0000000000000000000000000000000001" })
    const infos = generateContractInfos([tag], [{ chain: "1", address: "abcdef0000000000000000000000000000000001", tx_count: 42 }])
    assert.equal(infos[0].txCount, 42)
    const upper = makeTag({ chain: "1", tagAddress: "0XABCDEF0000000000000000000000000000000001" })
    assert.equal(
      generateContractInfos([upper], [{ chain: "1", address: "ABCDEF0000000000000000000000000000000001", tx_count: 7 }])[0].txCount,
      7
    )
  })

  it("matches Solana addresses exactly (base58 is case-sensitive)", () => {
    const address = solanaAddress("CaseSensitive")
    const tag = makeTag({ chain: SOLANA_CHAIN, tagAddress: address })
    assert.equal(generateContractInfos([tag], [{ chain: SOLANA_CHAIN, address, tx_count: 9 }])[0].txCount, 9)
    assert.equal(
      generateContractInfos([tag], [{ chain: SOLANA_CHAIN, address: address.toLowerCase(), tx_count: 9 }])[0].txCount,
      0
    )
  })

  it("requires the same chain: one address on two chains has two counts", () => {
    const address = evmAddress(0x5a5a)
    const gas = [
      { chain: "1", address: address.slice(2), tx_count: 1 },
      { chain: "100", address: address.slice(2), tx_count: 100 },
    ]
    assert.equal(generateContractInfos([makeTag({ chain: "100", tagAddress: address })], gas)[0].txCount, 100)
    assert.equal(generateContractInfos([makeTag({ chain: "137", tagAddress: address })], gas)[0].txCount, 0)
  })

  it("keeps every tag field", () => {
    const tag = makeTag({ registry: "domains", chain: "10" })
    const [info] = generateContractInfos([tag], [{ chain: "10", address: tag.tagAddress.slice(2), tx_count: 3 }])
    assert.deepEqual(info, { ...tag, txCount: 3 })
  })
})
