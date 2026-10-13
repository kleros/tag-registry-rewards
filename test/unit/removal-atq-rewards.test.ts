import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { utils } from "ethers"
import { buildRemovalRewards } from "../../src/removal-reward-builder"
import { buildAtqRewards } from "../../src/atq-reward-builder"
import { parseWei } from "../../src/utils/parse-wei"
import { captureConsole, CapturedConsole } from "../support/console"
import { withEnv } from "../support/env"
import { evmAddress, makeAtqRow, makeRemoval } from "../support/fixtures"

const pnk = (wei: { toString(): string }) => utils.formatEther(wei.toString())

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("buildRemovalRewards", () => {
  it("pays min(pool / removals, cap) per removal: capped while removals are few", () => {
    // baseline: 7,000 PNK pool and 500 PNK cap per registry
    const removals = Array.from({ length: 10 }, () => makeRemoval({ registry: "tokens" }))
    const rewards = buildRemovalRewards(removals)
    assert.equal(rewards.length, 10)
    assert.ok(rewards.every((r) => pnk(r.amount) === "500.0"))
  })

  it("splits the pool once it is saturated (pool / count, floored)", () => {
    const removals = Array.from({ length: 38 }, () => makeRemoval({ registry: "domains" }))
    const rewards = buildRemovalRewards(removals)
    // June 2026: 38 Domains removals saturated the pool at 184.21 PNK each
    assert.equal(rewards[0].amount.toString(), utils.parseEther("7000").div(38).toString())
    assert.ok(pnk(rewards[0].amount).startsWith("184.210526315789473684"))
  })

  it("computes each registry on its own", () => {
    const rewards = buildRemovalRewards([
      ...Array.from({ length: 20 }, () => makeRemoval({ registry: "addressTags" })),
      makeRemoval({ registry: "tokens" }),
    ])
    assert.equal(pnk(rewards.find((r) => r.removal.registry === "addressTags")!.amount), "350.0")
    assert.equal(pnk(rewards.find((r) => r.removal.registry === "tokens")!.amount), "500.0")
  })

  it("counts an item removed twice once, rewarding the latest removal's remover", () => {
    const address = evmAddress(0xabc)
    const first = makeRemoval({ tagAddress: address, chain: "1", removedAt: 100, submitter: evmAddress(1) })
    const latest = makeRemoval({ tagAddress: address.toUpperCase().replace("0X", "0x"), chain: "1", removedAt: 200, submitter: evmAddress(2) })
    const otherChain = makeRemoval({ tagAddress: address, chain: "10", removedAt: 150, submitter: evmAddress(3) })
    const rewards = buildRemovalRewards([first, latest, otherChain])
    assert.equal(rewards.length, 2)
    assert.deepEqual(rewards.map((r) => r.recipient).sort(), [evmAddress(2), evmAddress(3)])
  })

  it("dedupes removals without a tagged address by item id", () => {
    const id = "0x01@0xregistry"
    const rewards = buildRemovalRewards([
      makeRemoval({ id, tagAddress: "", removedAt: 1 }),
      makeRemoval({ id: id.toUpperCase(), tagAddress: "", removedAt: 2 }),
      makeRemoval({ id: "0x02@0xregistry", tagAddress: "" }),
    ])
    assert.equal(rewards.length, 2)
  })

  it("rewards the remover, with the removal kept for the reports", () => {
    const removal = makeRemoval({ registry: "tokens", submitter: evmAddress(0x5e) })
    const [reward] = buildRemovalRewards([removal])
    assert.equal(reward.recipient, evmAddress(0x5e))
    assert.equal(reward.id, removal.id)
    assert.deepEqual(reward.removal, removal)
  })

  it("returns nothing when nothing was removed", () => {
    assert.deepEqual(buildRemovalRewards([]), [])
  })

  it("rejects a malformed pool or cap", async () => {
    await withEnv({ REMOVAL_REWARD_POOL_TOKENS: "7000 PNK" }, () =>
      assert.throws(() => buildRemovalRewards([makeRemoval()]), /Invalid REMOVAL_REWARD_POOL_TOKENS="7000 PNK"/)
    )
    await withEnv({ REMOVAL_MAX_PER_REMOVAL_DOMAINS: "-1" }, () =>
      assert.throws(() => buildRemovalRewards([makeRemoval()]), /Invalid REMOVAL_MAX_PER_REMOVAL_DOMAINS/)
    )
  })
})

describe("buildAtqRewards", () => {
  it("computes registrations and removals with their own pools and caps", () => {
    // September 2026: 10 registrations (60,000 PNK pool, 3,000 cap) and 13 removals (6,500 pool, 500 cap)
    const registered = Array.from({ length: 10 }, () => makeAtqRow())
    const removed = Array.from({ length: 13 }, () => makeAtqRow())
    const rewards = buildAtqRewards(registered, removed)
    assert.equal(rewards.length, 23)
    assert.ok(rewards.filter((r) => r.kind === "registered").every((r) => pnk(r.amount) === "3000.0"))
    assert.ok(rewards.filter((r) => r.kind === "removed").every((r) => pnk(r.amount) === "500.0"))
    const total = rewards.reduce((acc, r) => acc.add(r.amount), utils.parseEther("0"))
    assert.equal(pnk(total), "36500.0")
  })

  it("splits a saturated pool", () => {
    const rewards = buildAtqRewards(Array.from({ length: 40 }, () => makeAtqRow()), Array.from({ length: 20 }, () => makeAtqRow()))
    assert.equal(pnk(rewards.find((r) => r.kind === "registered")!.amount), "1500.0")
    assert.equal(pnk(rewards.find((r) => r.kind === "removed")!.amount), "325.0")
  })

  it("drops rows without a requester, with a warning, and does not count them", () => {
    logs.clear()
    const rewards = buildAtqRewards([makeAtqRow(), makeAtqRow({ requester: "" })], [])
    assert.equal(rewards.length, 1)
    assert.ok(logs.has(/1 registered row\(s\) have no requester/))
  })

  it("ids every event by item and kind, and rewards the requester", () => {
    const row = makeAtqRow({ itemID: "0xabc", requester: evmAddress(7), metadata: "a | b" })
    const [reward] = buildAtqRewards([], [row])
    assert.deepEqual(
      { ...reward, amount: reward.amount.toString() },
      { recipient: evmAddress(7), id: "0xabc:removed", kind: "removed", itemID: "0xabc", metadata: "a | b", amount: utils.parseEther("500").toString() }
    )
  })

  it("returns nothing for an empty period", () => {
    assert.deepEqual(buildAtqRewards([], []), [])
  })
})

describe("parseWei", () => {
  it("accepts non-negative integers (wei), trimmed", () => {
    assert.equal(parseWei("X", " 7000000000000000000000 ").toString(), "7000000000000000000000")
    assert.equal(parseWei("X", "0").toString(), "0")
  })

  it("rejects decimals, negatives, units and blanks", () => {
    for (const bad of ["1.5", "-1", "7000 PNK", "", "1e21"]) {
      assert.throws(() => parseWei("POOL", bad), new RegExp(`Invalid POOL=.*Expected a non-negative integer`))
    }
  })
})
