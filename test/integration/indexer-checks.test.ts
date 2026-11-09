import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { assertIndexerComplete, GnosisReader } from "../../src/utils/indexer-checks"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { REGISTRY, unix } from "../support/fixtures"
import { MockSubgraph, subgraphItem } from "../support/subgraph"

const OCTOBER = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") }

// Gnosis as the check reads it: block n is at `t0 + 5 n` seconds, and each
// registry created the given items.
const gnosis = (created: { [registry: string]: string[] }, t0 = unix("2026-10-25T00:00:00Z") - 5 * 1000000): GnosisReader & { asked: number[] } => {
  const asked: number[] = []
  return {
    asked,
    blockTime: async (block) => t0 + 5 * block,
    createdItemIds: async (registry, toBlock) => {
      asked.push(toBlock)
      return created[registry] || []
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
  it("passes when it has processed past the period and holds every item the registries created", async () => {
    const a = subgraphItem("tokens")
    const b = subgraphItem("tokens", { status: "Absent" })
    subgraph.add(a, b)
    subgraph.progressBlock = 2000000 // 2026-11-20
    const reader = gnosis({ [REGISTRY.tokens]: [a.itemID, b.itemID] })
    await assertIndexerComplete(period(), [REGISTRY.tokens], reader)
    assert.deepEqual(reader.asked, [2000001], "only the blocks the indexer has processed are compared")
    assert.ok(logs.has(`all 2 items created on Gnosis are in the indexer`))
  })

  it("stops when the indexer has not processed the end of the period: its last days would be left out", async () => {
    subgraph.progressBlock = 1000000 // 2026-10-25
    await assert.rejects(assertIndexerComplete(period(), [REGISTRY.tokens], gnosis({})), /processed Gnosis only up to block 1000000 \(2026-10-25/)
  })

  it("stops when a registry created an item the indexer does not have", async () => {
    const kept = subgraphItem("domains")
    subgraph.add(kept)
    subgraph.progressBlock = 2000000
    const missing = "0x" + "ab".repeat(32)
    await assert.rejects(
      assertIndexerComplete(period(), [REGISTRY.domains], gnosis({ [REGISTRY.domains]: [kept.itemID, missing] })),
      new RegExp(`1 item\\(s\\) created on Gnosis are not in the indexer \\(${missing}\\)`)
    )
  })

  it("stops, rather than pass unchecked, when Gnosis cannot be read", async () => {
    subgraph.progressBlock = 2000000
    const down: GnosisReader = {
      blockTime: async () => {
        throw new Error("HyperSync unreachable")
      },
      createdItemIds: async () => [],
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
