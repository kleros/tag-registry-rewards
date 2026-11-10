import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { unlinkSync, writeFileSync } from "fs"
import { assertIndexerComplete, GnosisReader, ItemState } from "../../src/utils/indexer-checks"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { evmAddress, REGISTRY, unix } from "../support/fixtures"
import { MockItem, MockSubgraph, subgraphItem } from "../support/subgraph"

const OCTOBER = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") }
const IN_OCTOBER = unix("2026-10-15T00:00:00Z")
const LONG_AGO = unix("2025-01-15T00:00:00Z")

const registration = (requester: string, resolutionTime: number) => ({ requester, requestType: "RegistrationRequested" as const, resolutionTime })
const clearing = (requester: string, resolutionTime: number) => ({ requester, requestType: "ClearingRequested" as const, resolutionTime })

// Gnosis as the check reads it: block n is at `t0 + 5 n` seconds; each
// registry created the given items, last named by an event in October (active
// in the period) unless `lastEvent` says otherwise; each item is in the state
// the indexer shows unless `states` says otherwise; `touched` are named by an
// event while the indexer is read.
const gnosis = (
  created: { [registry: string]: string[] },
  opts: { states?: { [id: string]: ItemState }; lastEvent?: { [id: string]: number }; touched?: string[] } = {},
  t0 = unix("2026-10-25T00:00:00Z") - 5 * 1000000
): GnosisReader & { eventsTo: number[]; statesAt: number[] } => {
  const eventsTo: number[] = []
  const statesAt: number[] = []
  return {
    eventsTo,
    statesAt,
    blockTime: async (block) => t0 + 5 * block,
    registryEvents: async (registry, toBlock) => {
      eventsTo.push(toBlock)
      const ids = created[registry] || []
      const lastEvent = new Map<string, { block: number; time: number }>()
      for (const id of ids) lastEvent.set(id, { block: 10, time: (opts.lastEvent || {})[id] ?? IN_OCTOBER })
      for (const id of opts.touched || []) lastEvent.set(id, { block: toBlock - 1, time: t0 + 5 * (toBlock - 1) })
      return { created: ids, lastEvent }
    },
    itemStates: async (_registry, ids, block) => {
      statesAt.push(block)
      return new Map(
        ids.map((id): [string, ItemState] => {
          const item = subgraph.items.find((i) => i.itemID === id) as MockItem
          return [id, (opts.states || {})[id] || { status: item.status, requests: item.numberOfRequests }]
        })
      )
    },
  }
}

let subgraph: MockSubgraph
let logs: CapturedConsole
let restoreEnv: () => void
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(async () => {
  subgraph = await new MockSubgraph().start()
  subgraph.progressBlock = 2000000 // 2026-12-21: past the period
  restoreEnv = setEnv({ XDAI_GTCR_SUBGRAPH_URL: subgraph.url, INDEXER_CHECK: "on" })
  logs.clear()
})
afterEach(async () => {
  restoreEnv()
  await subgraph.stop()
})

// Each test asks for another period: a check that passed is not repeated in a process.
let n = 0
const period = () => ({ start: OCTOBER.start, end: new Date(OCTOBER.end.getTime() - ++n * 1000) })

describe("the indexer, checked against Gnosis", () => {
  it("passes when it has processed past the period and holds every item the registries created, as the registry does", async () => {
    const a = subgraphItem("tokens")
    const b = subgraphItem("tokens", { status: "Absent", requests: [registration(evmAddress(1), LONG_AGO), clearing(evmAddress(2), IN_OCTOBER)] })
    const challenged = subgraphItem("tokens", { status: "ClearingRequested", requests: [registration(evmAddress(1), IN_OCTOBER), clearing(evmAddress(2), 0)] })
    const direct = subgraphItem("tokens", { requests: [] }) // added directly by the governor: no request
    subgraph.add(a, b, challenged, direct)
    const reader = gnosis({ [REGISTRY.tokens]: [a.itemID, b.itemID, challenged.itemID, direct.itemID] })
    await assertIndexerComplete(period(), [REGISTRY.tokens], reader)
    assert.deepEqual(reader.eventsTo, [2000001], "only the blocks the indexer has processed are compared")
    assert.deepEqual(reader.statesAt, [2000000], "states read at the block the indexer reached")
    assert.ok(logs.has(`all 4 items created on Gnosis are in the indexer, 4 of them compared with the registry at block 2000000 (state and requests)`))
  })

  it("pages the indexer by id, so an item changing between pages hides none", async () => {
    const items = Array.from({ length: 1001 }, () => subgraphItem("domains"))
    subgraph.add(...items)
    await assertIndexerComplete(period(), [REGISTRY.domains], gnosis({ [REGISTRY.domains]: items.map((i) => i.itemID) }))
    const pages = subgraph.queries.filter((q) => q.registry === REGISTRY.domains)
    assert.deepEqual(pages.map((q) => q.idGt), ["", items.map((i) => i.id).sort()[999]])
  })

  it("stops when the indexer shows an item in a state the registry does not hold: a cached failed read", async () => {
    // registered on-chain, but the indexer's read of it failed (zeros) when the
    // registration resolved, so it still shows the request: never selected
    const stuck = subgraphItem("tokens", { status: "RegistrationRequested", requests: [registration(evmAddress(1), 0)] })
    const fine = subgraphItem("tokens")
    subgraph.add(stuck, fine)
    const reader = gnosis({ [REGISTRY.tokens]: [stuck.itemID, fine.itemID] }, { states: { [stuck.itemID]: { status: "Registered", requests: 1 } } })
    await assert.rejects(
      assertIndexerComplete(period(), [REGISTRY.tokens], reader),
      new RegExp(`1 item\\(s\\) active in the period are wrong in the indexer at block 2000000: ${stuck.itemID}: indexer RegistrationRequested/1 request\\(s\\), Gnosis Registered/1`)
    )
  })

  it("stops on a request the indexer lost while the item's own state is right again: a removal or registration never paid", async () => {
    // the removal's read failed when it was submitted: stored as request -1,
    // typed "Absent", with no requester; the removal resolved, the item is
    // Absent with 2 requests on both sides, and no removal is found to pay
    const lostRemoval = subgraphItem("tokens", {
      status: "Absent",
      numberOfRequests: 2,
      requests: [registration(evmAddress(1), LONG_AGO), { requester: "0x0000000000000000000000000000000000000000", requestType: "Absent", resolutionTime: 0 }],
    })
    lostRemoval.requests[1].id = `${lostRemoval.id}--1`
    // the registration's resolution was never written (a removal request came
    // in the same block): neither selection window can match it
    const lostRegistration = subgraphItem("domains", {
      status: "ClearingRequested",
      requests: [registration(evmAddress(1), 0), clearing(evmAddress(2), 0)],
    })
    const noRequester = subgraphItem("domains", { requests: [registration("0x0000000000000000000000000000000000000000", IN_OCTOBER)] })
    subgraph.add(lostRemoval, lostRegistration, noRequester)
    await assert.rejects(
      assertIndexerComplete(period(), [REGISTRY.tokens], gnosis({ [REGISTRY.tokens]: [lostRemoval.itemID] })),
      new RegExp(`${lostRemoval.itemID}: request ${lostRemoval.id}--1 is not one of its 2`)
    )
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.domains], gnosis({ [REGISTRY.domains]: [lostRegistration.itemID, noRequester.itemID] })), (err: Error) => {
      assert.ok(err.message.includes(`${lostRegistration.itemID}: request 0 (RegistrationRequested) has no resolution`))
      assert.ok(err.message.includes(`${noRequester.itemID}: request 0 has no requester`))
      return true
    })
  })

  it("only warns about an item untouched since before the period, which cannot change its payout", async () => {
    const old = subgraphItem("tokens", { status: "RegistrationRequested", requests: [registration(evmAddress(1), 0)] })
    const missing = "0x" + "ab".repeat(32)
    subgraph.add(old)
    const reader = gnosis(
      { [REGISTRY.tokens]: [old.itemID, missing] },
      { states: { [old.itemID]: { status: "Registered", requests: 1 } }, lastEvent: { [old.itemID]: LONG_AGO, [missing]: LONG_AGO } }
    )
    await assertIndexerComplete(period(), [REGISTRY.tokens], reader)
    assert.ok(logs.has(/2 item\(s\) wrong in the indexer, none of them able to change this period's payout/))
    assert.ok(logs.has(`${missing}: created on Gnosis, not in the indexer (untouched since before the period)`))
  })

  it("lets a wrong item active in the period through once exclusions.json names it, to be paid by hand", async () => {
    const stuck = subgraphItem("tokens", { status: "RegistrationRequested", requests: [registration(evmAddress(1), 0)] })
    subgraph.add(stuck)
    const reader = () => gnosis({ [REGISTRY.tokens]: [stuck.itemID] }, { states: { [stuck.itemID]: { status: "Registered", requests: 1 } } })
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], reader()), /name the item in exclusions\.json/)
    // an entry for one kind of payout does not cover it: it could be a removal the indexer lost
    writeFileSync("exclusions.json", JSON.stringify([{ itemID: stuck.itemID, scope: "submissions", reason: "excluded for another reason" }]))
    try {
      await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], reader()), /"scope": "all"/)
    } finally {
      unlinkSync("exclusions.json")
    }
    writeFileSync("exclusions.json", JSON.stringify([{ itemID: stuck.itemID, scope: "all", reason: "indexer wrong, paid by hand" }]))
    try {
      await assertIndexerComplete(period(), [REGISTRY.tokens], reader())
      assert.ok(logs.has("(named in exclusions.json: not paid automatically)"))
    } finally {
      unlinkSync("exclusions.json")
    }
  })

  it("stops when the indexer holds items Gnosis shows no NewItem for: a read of Gnosis that came back empty proves nothing", async () => {
    subgraph.add(subgraphItem("tokens"), subgraphItem("tokens"))
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], gnosis({})), /the indexer holds 2 item\(s\) Gnosis shows no NewItem for/)
  })

  it("leaves out of the comparison only the items an event names while the indexer is read", async () => {
    const moving = subgraphItem("tokens", { status: "RegistrationRequested", requests: [registration(evmAddress(1), 0)] })
    const created = "0x" + "cd".repeat(32)
    subgraph.add(moving)
    // the indexer reaches 2000000, then 2000005 by the time it has been read;
    // `created` is created on-chain in between and not yet in what was read
    subgraph.progressBlocks = [2000000, 2000005]
    const reader = gnosis(
      { [REGISTRY.tokens]: [moving.itemID, created] },
      { states: { [moving.itemID]: { status: "Registered", requests: 1 } }, touched: [moving.itemID, created] }
    )
    await assertIndexerComplete(period(), [REGISTRY.tokens], reader)
    assert.deepEqual(reader.eventsTo, [2000006])
    assert.ok(logs.has("0 of them compared with the registry at block 2000005 (state and requests) (1 changing while read, not compared)"))
    // an item untouched in that window is compared
    const stuck = subgraphItem("domains", { status: "RegistrationRequested", requests: [registration(evmAddress(1), 0)] })
    subgraph.add(stuck)
    subgraph.progressBlocks = [2000000, 2000005]
    await assert.rejects(
      assertIndexerComplete(period(), [REGISTRY.domains], gnosis({ [REGISTRY.domains]: [stuck.itemID] }, { states: { [stuck.itemID]: { status: "Registered", requests: 1 } } })),
      /are wrong in the indexer at block 2000005/
    )
  })

  it("stops when the indexer has not processed the end of the period: its last days would be left out", async () => {
    subgraph.progressBlock = 1000000 // 2026-10-25
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], gnosis({})), /processed Gnosis only up to block 1000000 \(2026-10-25/)
  })

  it("stops when a registry created an item active in the period that the indexer does not have", async () => {
    const kept = subgraphItem("domains")
    subgraph.add(kept)
    const missing = "0x" + "ab".repeat(32)
    await assert.rejects(
      assertIndexerComplete(period(), [REGISTRY.domains], gnosis({ [REGISTRY.domains]: [kept.itemID, missing] })),
      new RegExp(`1 item\\(s\\) active in the period are wrong in the indexer at block 2000000: ${missing}: created on Gnosis, not in the indexer`)
    )
  })

  it("stops, rather than pass unchecked, when Gnosis cannot be read", async () => {
    const down: GnosisReader = {
      ...gnosis({}),
      blockTime: async () => {
        throw new Error("HyperSync unreachable")
      },
    }
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], down), /could not check the indexer against Gnosis \(HyperSync unreachable\)/)
  })

  it("is skipped, with a warning, when INDEXER_CHECK=off", async () => {
    const restore = setEnv({ INDEXER_CHECK: "off" })
    try {
      await assertIndexerComplete(period(), [REGISTRY.tokens], gnosis({ [REGISTRY.tokens]: ["0x" + "cd".repeat(32)] }))
      assert.ok(logs.has("INDEXER_CHECK=off"))
    } finally {
      restore()
    }
  })
})
