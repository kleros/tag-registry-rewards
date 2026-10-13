import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { join } from "path"
import { Tag } from "../../src/types"
import { BudgetExceededError, isBudgetExceeded } from "../../src/utils/runtime-helpers"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv, withEnv } from "../support/env"
import { MockDune } from "../support/dune"
import { freshWorkdir, readCsv, readJson, writeJson } from "../support/files"
import { evmAddress, SOLANA_CHAIN, solanaAddress, unix } from "../support/fixtures"
import { MockSubgraph, subgraphItem } from "../support/subgraph"

// Routines over the subgraph and Dune mocks. dune-client reads its settings
// when loaded, so the modules are required once the mocks are up.
type TagsRoutine = typeof import("../../src/tags-routine")
let routines: TagsRoutine
let removals: typeof import("../../src/removals-routine")
let filterCheck: typeof import("../../src/filter-check-routine")
const validation = require("../../src/utils/address-tag-validation")
const explorer = require("../../src/utils/is-tagged-on-etherscan")
const sender = require("../../src/transaction-sender")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let evmLane: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let solanaLane: any

const PERIOD = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") }
const IN = unix("2026-09-15T00:00:00Z")
const BEFORE = unix("2026-08-15T00:00:00Z")
const reg = (requester: string, at = IN) => ({ requester, requestType: "RegistrationRequested" as const, resolutionTime: at, submissionTime: at - 60 })
const clr = (requester: string, at = IN) => ({ requester, requestType: "ClearingRequested" as const, resolutionTime: at, submissionTime: at - 60 })

let subgraph: MockSubgraph
let dune: MockDune
let logs: CapturedConsole
let work: string
const originals: { [k: string]: unknown } = {}

before(async () => {
  logs = captureConsole()
  dune = await new MockDune().start()
  setEnv({
    EVM_TX_PROVIDER: "dune",
    SOLANA_TX_PROVIDER: "dune",
    DUNE_API_KEY: "k",
    DUNE_BASE_URL: dune.url,
    DUNE_POLL_INTERVAL_SECONDS: "0",
    DUNE_HTTP_RETRY_BASE_MS: "1",
  })
  evmLane = require("../../src/utils/evm-enrichment")
  solanaLane = require("../../src/utils/solana-enrichment")
  routines = require("../../src/tags-routine")
  removals = require("../../src/removals-routine")
  filterCheck = require("../../src/filter-check-routine")
  originals.reason = validation.getAddressTagExclusionReason
  originals.explorer = explorer.isTaggedOnEtherscan
  originals.sleep = sender.sleep
  validation.getAddressTagExclusionReason = async (tag: Tag) => (tag.tagAddress === evmAddress(0xe0a) ? "not a contract (getCode == 0x)" : null)
  explorer.isTaggedOnEtherscan = async () => false
  sender.sleep = async () => undefined
})
after(async () => {
  validation.getAddressTagExclusionReason = originals.reason
  explorer.isTaggedOnEtherscan = originals.explorer
  sender.sleep = originals.sleep
  logs.restore()
  await dune.stop()
})
let restoreSubgraph: () => void
beforeEach(async () => {
  work = freshWorkdir()
  subgraph = await new MockSubgraph().start()
  restoreSubgraph = setEnv({ XDAI_GTCR_SUBGRAPH_URL: subgraph.url })
  logs.clear()
})
afterEach(async () => {
  restoreSubgraph()
  await subgraph.stop()
})

describe("tagsRoutine (fetch)", () => {
  it("fetches, filters, counts and writes the generate inputs of the period", async () => {
    const popular = solanaAddress("Popular")
    const fewHolders = solanaAddress("Few")
    subgraph.add(
      subgraphItem("addressTags", { requests: [reg(evmAddress(1))], key0: `eip155:1:${evmAddress(0xc1)}` }),
      subgraphItem("addressTags", { requests: [reg(evmAddress(2))], key0: `eip155:8453:${evmAddress(0xe0a)}` }),
      subgraphItem("addressTags", { requests: [reg(evmAddress(3))], key0: `eip155:1:${evmAddress(0xc3)}`, key1: "Foo Token" }),
      subgraphItem("tokens", { requests: [reg(evmAddress(4))], key0: `solana:${SOLANA_CHAIN}:${popular}` }),
      subgraphItem("tokens", { requests: [reg(evmAddress(5))], key0: `solana:${SOLANA_CHAIN}:${fewHolders}` }),
      subgraphItem("domains", { requests: [reg(evmAddress(6))], key0: `eip155:56:${evmAddress(0xd6)}` })
    )
    dune.evmCounts = { "1": { [evmAddress(0xc1)]: 1234 } }
    dune.solanaCounts = { [popular]: 99999, [fewHolders]: 50 }
    dune.solanaHolders = { [popular]: 12000, [fewHolders]: 40 }

    const manifest = await routines.tagsRoutine(PERIOD)
    assert.equal(manifest.includedCount, 2)
    assert.equal(manifest.excludedCount, 3, "an EOA, a token name in Address Tags, an unrewarded chain")
    assert.equal(manifest.droppedBySolanaHoldersCount, 1)
    assert.equal(manifest.periodStart, "2026-09-01T00:00:00.000Z")
    assert.equal(manifest.enrichment!.evm.provider, "dune")
    const gas = readJson(join(work, "files", manifest.generateGasFile)).sort((a: { chain: string }, b: { chain: string }) =>
      a.chain.localeCompare(b.chain)
    )
    assert.deepEqual(gas, [
      { chain: "1", address: evmAddress(0xc1).slice(2), tx_count: 1234 },
      { chain: SOLANA_CHAIN, address: popular, tx_count: 99999 },
    ])
    assert.deepEqual(readJson(join(work, "files", "latest_fetch_manifest.json")).runId, manifest.runId)
  })

  it("never writes outputs when a count is missing (payouts are never split on zeros)", async () => {
    subgraph.add(subgraphItem("tokens", { requests: [reg(evmAddress(1))], key0: `eip155:1:${evmAddress(0xc9)}` }))
    const real = evmLane.enrichAllEvmAddresses
    evmLane.enrichAllEvmAddresses = async () => ({ byChain: { "1": {} }, provenance: { provider: "dune", definition: "x" } })
    try {
      await assert.rejects(routines.tagsRoutine(PERIOD), /No tx count returned for 1:0x0+c9/)
    } finally {
      evmLane.enrichAllEvmAddresses = real
    }
    assert.ok(!require("fs").existsSync(join(work, "files", "latest_fetch_manifest.json")))
  })
})

describe("enrichTags: the two lanes", () => {
  const tags = [
    { id: "1", registry: "tokens", chain: "1", submitter: evmAddress(1), tagAddress: evmAddress(0xc1), latestRequestResolutionTime: IN, isTokenOnAddressTags: false, addressTagName: "" },
    { id: "2", registry: "addressTags", chain: SOLANA_CHAIN, submitter: evmAddress(2), tagAddress: solanaAddress("Lane"), latestRequestResolutionTime: IN, isTokenOnAddressTags: false, addressTagName: "" },
  ] as Tag[]
  const stub = async (evm: () => Promise<unknown>, solana: () => Promise<unknown>, fn: () => Promise<void>) => {
    const realEvm = evmLane.enrichAllEvmAddresses
    const realSolana = solanaLane.enrichSolanaTagsBatch
    evmLane.enrichAllEvmAddresses = evm
    solanaLane.enrichSolanaTagsBatch = solana
    try {
      await fn()
    } finally {
      evmLane.enrichAllEvmAddresses = realEvm
      solanaLane.enrichSolanaTagsBatch = realSolana
    }
  }

  it("lets the other lane finish (and checkpoint) when one fails, then fails loudly", async () => {
    let solanaFinished = false
    await stub(
      async () => {
        throw new Error("hypersync down")
      },
      async () => {
        await new Promise((r) => setTimeout(r, 50))
        solanaFinished = true
        return { byKey: {}, provenance: { provider: "rpc", definition: "x" } }
      },
      () => assert.rejects(routines.enrichTags(tags), /Transaction counts failed, no output was written.*EVM: hypersync down/s)
    )
    assert.ok(solanaFinished)
  })

  it("reports a --max-minutes stop as such, not as a failure", async () => {
    await stub(
      async () => {
        throw new BudgetExceededError()
      },
      async () => ({ byKey: {}, provenance: { provider: "rpc", definition: "x" } }),
      () => assert.rejects(routines.enrichTags(tags), (err: unknown) => isBudgetExceeded(err))
    )
  })
})

describe("prefetchRoutine", () => {
  it("needs the cache and the free providers", async () => {
    await withEnv({ TX_COUNT_CACHE: "off" }, () => assert.rejects(routines.prefetchRoutine(PERIOD), /needs the tx-count cache/))
    await assert.rejects(routines.prefetchRoutine(PERIOD), /the Dune providers keep no cache/)
  })
})

describe("removalsRoutine", () => {
  it("rewards removers and ATQ, and writes every output", async () => {
    subgraph.add(
      subgraphItem("tokens", { status: "Absent", requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xd1))] }),
      subgraphItem("domains", { status: "Absent", requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xd2))] }),
      subgraphItem("atq", { status: "Registered", requests: [reg(evmAddress(0xa1))] }),
      subgraphItem("atq", { status: "Absent", requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xa2))] })
    )
    const manifest = await removals.removalsRoutine(PERIOD)
    assert.equal(manifest.removalCount, 2)
    assert.equal(manifest.atqRewardCount, 2)
    const tx = readJson(join(work, "files", manifest.transactionsFile))
    assert.deepEqual(tx.map((t: { recipient: string }) => t.recipient).sort(), [evmAddress(0xd1), evmAddress(0xd2)])
    const atq = readJson(join(work, "files", manifest.atqTransactionsFile))
    assert.deepEqual(atq.map((t: { recipient: string }) => t.recipient).sort(), [evmAddress(0xa1), evmAddress(0xa2)])
  })

  it("applies exclusions before the dedupe: excluding a bogus latest removal lets the earlier one count", async () => {
    const key0 = `eip155:1:${evmAddress(0xfeed)}`
    const earlier = subgraphItem("addressTags", { status: "Absent", key0, requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xe1), IN - 1000)] })
    const later = subgraphItem("addressTags", { status: "Absent", key0, requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xe2), IN)] })
    subgraph.add(earlier, later)
    writeJson(join(work, "exclusions.json"), [{ itemID: later.itemID, scope: "removals", reason: "self-removal" }])
    const manifest = await removals.removalsRoutine(PERIOD)
    const records = readJson(join(work, "files", manifest.removalsJsonFile))
    assert.deepEqual(records.map((r: { recipient: string }) => r.recipient), [evmAddress(0xe1)])
    assert.ok(logs.has("[exclusions] Dropping removals"))
  })
})

describe("filterCheckRoutine", () => {
  it("reports what fetch would exclude, without counting anything", async () => {
    subgraph.add(
      subgraphItem("addressTags", { requests: [reg(evmAddress(1))], key0: `eip155:8453:${evmAddress(0xe0a)}` }),
      subgraphItem("domains", { requests: [reg(evmAddress(2))], key0: `eip155:250:${evmAddress(0xf7)}` }),
      subgraphItem("tokens", { requests: [reg(evmAddress(3))], key0: `eip155:1:${evmAddress(0xc3)}` })
    )
    dune.sqls = []
    const report = await filterCheck.filterCheckRoutine(PERIOD)
    assert.equal(report.excludedCount, 2)
    const csv = readCsv(join(work, "files", report.csvFile))
    assert.deepEqual(
      csv.filter((r) => r[0] === "detail").map((r) => r[1]).sort(),
      ["chain not configured for rewards", "not a contract (getCode == 0x)"]
    )
    assert.equal(dune.sqls.length, 0, "no tx count is fetched")
  })
})
