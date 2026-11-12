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
import { MockChain, newChain } from "../support/solana"

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
let chain: MockChain

// Routines over the subgraph and Dune mocks. dune-client reads its settings
// when loaded, so the modules are required once the mocks are up.
type TagsRoutine = typeof import("../../src/tags-routine")
let routines: TagsRoutine
let removals: typeof import("../../src/removals-routine")
let filterCheck: typeof import("../../src/filter-check-routine")
const validation = require("../../src/utils/address-tag-validation")
const explorerTags = require("../../src/utils/explorer-tags")
const pm = require("../../src/utils/prediction-market-detection")
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
  // Solana holders: Jupiter, then the token accounts, on the Dune lane too
  chain = await newChain(1)
  for (const program of [TOKEN_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    chain.accounts[program] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }
  }
  setEnv({
    SOLANA_RPC_URLS: chain.urls().join(","),
    JUPITER_TOKENS_API_URL: chain.jupiterUrl,
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
  originals.explorer = explorerTags.checkExplorerTags
  originals.sleep = sender.sleep
  originals.pm = pm.detectPredictionMarketTokens
  pm.detectPredictionMarketTokens = async () => ({})
  validation.getAddressTagExclusionReason = async (tag: Tag) => (tag.tagAddress === evmAddress(0xe0a) ? "not a contract (getCode == 0x)" : null)
  // on etherscan.io evmAddress(0xc3) has a name tag; arbiscan.io cannot be read
  explorerTags.checkExplorerTags = async (items: { key: string; host: string; address: string }[]) =>
    new Map(
      items.map((i) => [
        i.key,
        i.host === "arbiscan.io"
          ? { tagged: null, names: [], ignored: [], detail: "arbiscan.io shuts scripts out (Cloudflare challenge)", url: `https://arbiscan.io/address/${i.address}` }
          : { tagged: i.address === evmAddress(0xc3), names: ["Circle: USDC Token"], ignored: [], detail: "", url: `https://${i.host}/address/${i.address}` },
      ])
    )
  sender.sleep = async () => undefined
})
after(async () => {
  validation.getAddressTagExclusionReason = originals.reason
  explorerTags.checkExplorerTags = originals.explorer
  sender.sleep = originals.sleep
  pm.detectPredictionMarketTokens = originals.pm
  logs.restore()
  await dune.stop()
  await chain.stop()
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
    chain.jupiter[popular] = { holderCount: 12000, tokenProgram: TOKEN_PROGRAM }
    chain.jupiter[fewHolders] = { holderCount: 40, tokenProgram: TOKEN_PROGRAM }
    chain.accounts[fewHolders] = { owner: TOKEN_PROGRAM }
    for (let i = 0; i < 40; i++) chain.tokenAccounts.push({ mint: fewHolders, owner: Buffer.alloc(32, i + 1) })

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

  it("records the explorer check's review file, named with the fetch's runId, in its manifest", async () => {
    subgraph.add(subgraphItem("tokens", { requests: [reg(evmAddress(4))], key0: `eip155:1:${evmAddress(0xc3)}` }))
    dune.evmCounts = { "1": { [evmAddress(0xc3)]: 10 } }
    const manifest = await withEnv({ EXPLORER_CHECK: "on" }, () => routines.tagsRoutine(PERIOD))
    assert.deepEqual(manifest.explorerCheck, { file: `${manifest.runId}_explorer_check.csv`, tagged: 1, notRead: 0 })
    assert.ok(require("fs").existsSync(join(work, "files", manifest.explorerCheck!.file)))
    assert.equal(manifest.includedCount, 1, "listed for review, not excluded")
  })

  it("records what the dated check excluded and paid by default in the fetch manifest, and counts no excluded entry", async () => {
    const tagDating = require("../../src/utils/tag-dating")
    const realDating = tagDating.dateExplorerTags
    tagDating.dateExplorerTags = async (items: { key: string }[]) =>
      new Map(items.map((i) => [i.key, { decision: "excluded", evidence: "its token logo was written before the submission" }]))
    try {
      subgraph.add(
        subgraphItem("tokens", { requests: [reg(evmAddress(4))], key0: `eip155:1:${evmAddress(0xc3)}` }),
        subgraphItem("tokens", { requests: [reg(evmAddress(5))], key0: `eip155:1:${evmAddress(0xc4)}` })
      )
      dune.evmCounts = { "1": { [evmAddress(0xc3)]: 10, [evmAddress(0xc4)]: 20 } }
      const manifest = await withEnv({ EXPLORER_CHECK: "on", EXPLORER_DATING_SINCE: "2026-09-01" }, () => routines.tagsRoutine(PERIOD))
      assert.deepEqual(manifest.explorerCheck, {
        file: `${manifest.runId}_explorer_check.csv`,
        tagged: 1,
        notRead: 0,
        excluded: 1,
        paidByDefault: 0,
        unchecked: 0,
      })
      assert.equal(manifest.includedCount, 1, "the entry tagged before its submission is not rewarded")
      assert.equal(manifest.excludedCount, 1)
      assert.ok(logs.has("nothing to do by hand"))
    } finally {
      tagDating.dateExplorerTags = realDating
    }
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
    assert.equal(report.explorerCheckFile, undefined, "EXPLORER_CHECK=off in the test baseline")
  })

  it("with the explorer check, lists each entry tagged on its explorer or not readable, for review", async () => {
    subgraph.add(
      subgraphItem("tokens", { requests: [reg(evmAddress(3))], key0: `eip155:1:${evmAddress(0xc3)}` }),
      subgraphItem("tokens", { requests: [reg(evmAddress(4))], key0: `eip155:42161:${evmAddress(0xa4)}` }),
      subgraphItem("domains", { requests: [reg(evmAddress(5))], key0: `eip155:1:${evmAddress(0xc3)}` })
    )
    const report = await withEnv({ EXPLORER_CHECK: "on" }, () => filterCheck.filterCheckRoutine(PERIOD))
    assert.equal(report.excludedCount, 0, "nothing is excluded for it automatically")
    assert.deepEqual([report.explorerTaggedCount, report.explorerNotReadCount], [1, 1])
    const review = readCsv(join(work, "files", report.explorerCheckFile as string))
    const header = review[0]
    assert.deepEqual(header, [
      "Explorer",
      "Decision",
      "Item ID",
      "Submitter",
      "Registry",
      "Chain ID",
      "Address tagged",
      "Submitted at",
      "Registered at",
      "Explorer page",
      "Tags there, or why not read",
      "Evidence",
    ])
    const col = (name: string) => header.indexOf(name)
    assert.deepEqual(
      review.slice(1).map((r) => [r[col("Explorer")], r[col("Decision")], r[col("Chain ID")], r[col("Explorer page")], r[col("Tags there, or why not read")]]),
      [
        ["tagged", "to review by hand", "1", `https://etherscan.io/address/${evmAddress(0xc3)}`, "etherscan.io: Circle: USDC Token"],
        ["not read", "to review by hand", "42161", `https://arbiscan.io/address/${evmAddress(0xa4)}`, "arbiscan.io shuts scripts out (Cloudflare challenge)"],
      ],
      "September 2026 predates the dated check (EXPLORER_DATING_SINCE, 2026-11-01): listed for a check by hand"
    )
    assert.equal(review[1][col("Submitted at")], new Date((IN - 60) * 1000).toISOString())
  })

  it("tells the dated check about an earlier Kleros entry of an address, from the indexer", async () => {
    const tagDating = require("../../src/utils/tag-dating")
    const realDating = tagDating.dateExplorerTags
    const said: (string | null)[] = []
    type Item = { key: string }
    tagDating.dateExplorerTags = async (items: Item[], options: { earlierKlerosEntry: (item: Item, before: number) => Promise<string | null> }) => {
      for (const i of items) said.push(await options.earlierKlerosEntry(i, IN), await options.earlierKlerosEntry(i, IN - 86400 * 500))
      return new Map(items.map((i) => [i.key, { decision: "paid by default", evidence: "no dated evidence" }]))
    }
    try {
      subgraph.add(
        subgraphItem("tokens", { requests: [reg(evmAddress(3))], key0: `eip155:1:${evmAddress(0xc3)}` }),
        // the same address, registered in Address Tags 400 days before
        subgraphItem("addressTags", { requests: [reg(evmAddress(7), IN - 86400 * 400)], key0: `eip155:1:${evmAddress(0xc3)}` })
      )
      await withEnv({ EXPLORER_CHECK: "on", EXPLORER_DATING_SINCE: "2026-09-01" }, () => filterCheck.filterCheckRoutine(PERIOD))
      assert.equal(said.length, 2)
      assert.match(
        said[0] as string,
        /^Kleros entry 0x[0-9a-f]{64}@0x66260c69d03837016d88c9877e61e08ef74c59f2 registered this address on .+, and a tag an explorer took from Kleros never counts$/,
        "evidence dated after the earlier entry may be its echo"
      )
      assert.equal(said[1], null, "evidence dated before any Kleros entry of the address is not")
    } finally {
      tagDating.dateExplorerTags = realDating
    }
  })

  it("from the periods the dated check applies to, excludes on dated evidence and lists every verdict", async () => {
    const tagDating = require("../../src/utils/tag-dating")
    const realDating = tagDating.dateExplorerTags
    const asked: { address: string; submissionTime?: number; tagged: boolean | null }[] = []
    tagDating.dateExplorerTags = async (items: { key: string; address: string; submissionTime?: number; tagged: boolean | null }[]) => {
      asked.push(...items.map(({ address, submissionTime, tagged }) => ({ address, submissionTime, tagged })))
      return new Map(
        items.map((i) => [
          i.key,
          i.tagged
            ? { decision: "excluded", evidence: "archived with the public name tag \"Circle: USDC Token\" on 2026-01-01T00:00:00Z, before the submission" }
            : { decision: "paid by default", evidence: "its explorer could not be read, with no dated evidence" },
        ])
      )
    }
    try {
      subgraph.add(
        subgraphItem("tokens", { requests: [reg(evmAddress(3))], key0: `eip155:1:${evmAddress(0xc3)}` }),
        subgraphItem("tokens", { requests: [reg(evmAddress(4))], key0: `eip155:42161:${evmAddress(0xa4)}` })
      )
      const report = await withEnv({ EXPLORER_CHECK: "on", EXPLORER_DATING_SINCE: "2026-09-01" }, () => filterCheck.filterCheckRoutine(PERIOD))
      assert.deepEqual(
        asked,
        [
          { address: evmAddress(0xc3), submissionTime: IN - 60, tagged: true },
          { address: evmAddress(0xa4), submissionTime: IN - 60, tagged: null },
        ],
        "each entry tagged today or not readable is dated against its registration's submission"
      )
      assert.equal(report.excludedCount, 1)
      assert.deepEqual(report.summaryByReason.find((s) => s.reason === "tagged on explorer before submission"), { reason: "tagged on explorer before submission", count: 1 })
      assert.equal(report.explorerPaidByDefaultCount, 1)
      const review = readCsv(join(work, "files", report.explorerCheckFile as string))
      const col = (name: string) => review[0].indexOf(name)
      assert.deepEqual(
        review.slice(1).map((r) => [r[col("Decision")], r[col("Evidence")]]),
        [
          ["excluded", "archived with the public name tag \"Circle: USDC Token\" on 2026-01-01T00:00:00Z, before the submission"],
          ["paid by default", "its explorer could not be read, with no dated evidence"],
        ]
      )
      const filterCsv = readCsv(join(work, "files", report.csvFile))
      const detail = filterCsv.find((r) => r[0] === "detail" && r[1] === "tagged on explorer before submission")
      assert.ok(detail && /before the submission/.test(detail[detail.length - 1]), "the evidence is the exclusion's detail")
    } finally {
      tagDating.dateExplorerTags = realDating
    }
  })
})
