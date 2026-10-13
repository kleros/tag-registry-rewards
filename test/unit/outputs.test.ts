import { after, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils } from "ethers"
import { join } from "path"
import { writeRemovalsOutputs } from "../../src/utils/removals-output"
import { writeFetchOutputs } from "../../src/utils/fetch-output"
import { writeFilterCheckOutput } from "../../src/utils/filter-check-output"
import { ensureFilesDir, formatRegistry } from "../../src/utils/output-helpers"
import { buildRemovalRewards } from "../../src/removal-reward-builder"
import { buildAtqRewards } from "../../src/atq-reward-builder"
import { EnrichedTag, FilterCheckRow } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { freshWorkdir, listFiles, readCsv, readJson } from "../support/files"
import { evmAddress, makeAtqRow, makeRemoval, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

const PERIOD = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") }

let logs: CapturedConsole
let work: string
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(() => {
  work = freshWorkdir()
})
const file = (name: string) => join(work, "files", name)

describe("output helpers", () => {
  it("creates FILES_DIR when missing and names registries for humans", () => {
    ensureFilesDir()
    ensureFilesDir()
    assert.deepEqual(listFiles(join(work, "files")), [])
    assert.equal(formatRegistry("addressTags"), "Address Tags")
    assert.equal(formatRegistry("tokens"), "Kleros Tokens")
    assert.equal(formatRegistry("domains"), "Domains")
  })
})

describe("writeRemovalsOutputs", () => {
  const scenario = () => {
    const remover = "0xAbCd000000000000000000000000000000000001"
    const removals = [
      makeRemoval({ registry: "tokens", submitter: remover, chain: "100", chainName: "Gnosis Chain", removedAt: 1789000000 }),
      makeRemoval({ registry: "domains", submitter: remover.toLowerCase(), chain: "1", chainName: "", removedAt: 1789100000 }),
      makeRemoval({ registry: "addressTags", submitter: evmAddress(0x2), removedAt: 1789200000 }),
    ]
    const rewards = buildRemovalRewards(removals)
    const registered = [makeAtqRow({ requester: evmAddress(0x3), metadata: "eip155:1:0x1 | Name" }), makeAtqRow({ requester: "" })]
    const absent = [makeAtqRow({ requester: evmAddress(0x3) })]
    const atqRewards = buildAtqRewards(registered, absent)
    return { remover, rewards, registered, absent, atqRewards }
  }

  it("writes every report and send file, and a manifest naming them", async () => {
    const { rewards, registered, absent, atqRewards } = scenario()
    const manifest = await writeRemovalsOutputs("123", PERIOD, rewards, registered, absent, atqRewards)
    assert.deepEqual(manifest, {
      runId: "123",
      generatedAt: manifest.generatedAt,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      removalsCsvFile: "123_removals.csv",
      removalsJsonFile: "123_removals.json",
      transactionsFile: "123_removals_transactions.json",
      transactionsCsvFile: "123_removals_transactions.csv",
      atqRegisteredCsvFile: "123_atq_registered.csv",
      atqAbsentCsvFile: "123_atq_absent.csv",
      atqRewardsJsonFile: "123_atq.json",
      atqTransactionsFile: "123_atq_transactions.json",
      atqTransactionsCsvFile: "123_atq_transactions.csv",
      removalCount: 3,
      atqRegisteredCount: 2,
      atqAbsentCount: 1,
      atqRewardCount: 2,
    })
    for (const name of Object.values(manifest).filter((v) => typeof v === "string" && /\.(csv|json)$/.test(v as string))) {
      assert.ok(listFiles(join(work, "files")).includes(name as string), `${name} was not written`)
    }
    assert.deepEqual(readJson(file("latest_removals_manifest.json")), manifest)
    assert.deepEqual(readJson(file("123_removals_manifest.json")), manifest)
  })

  it("pays each remover once, summing their removals whatever the address casing", async () => {
    const { remover, rewards, registered, absent, atqRewards } = scenario()
    await writeRemovalsOutputs("1", PERIOD, rewards, registered, absent, atqRewards)
    // rewards come registry by registry (addressTags, tokens, domains)
    const transactions = readJson(file("1_removals_transactions.json"))
    assert.deepEqual(
      transactions.map((t: { recipient: string }) => t.recipient),
      [evmAddress(0x2), remover],
      "one transfer per remover, keeping the first casing seen"
    )
    assert.equal(BigNumber.from(transactions[1].amount).toString(), utils.parseEther("1000").toString())
    assert.equal(transactions[1].amount.type, "BigNumber", "send reads ethers' BigNumber JSON")
    assert.deepEqual(readCsv(file("1_removals_transactions.csv")), [
      ["Recipient", "Amount"],
      [evmAddress(0x2), "500"],
      [remover, "1000"],
    ])
  })

  it("keeps a record per removal for the document step", async () => {
    const { rewards, registered, absent, atqRewards } = scenario()
    await writeRemovalsOutputs("1", PERIOD, rewards, registered, absent, atqRewards)
    const records = readJson(file("1_removals.json"))
    assert.equal(records.length, 3)
    assert.deepEqual(Object.keys(records[0]).sort(), ["amount", "chain", "chainName", "id", "recipient", "registry", "tagAddress"])
    const domain = records.find((r: { registry: string }) => r.registry === "domains")
    assert.equal(domain.chainName, "1", "a removal without a chain name falls back to its chain id")
    assert.ok(records.every((r: { amount: string }) => /^\d+$/.test(r.amount)))
    const csv = readCsv(file("1_removals.csv"))
    assert.deepEqual(csv[0], ["Submitter", "Registry", "Chain", "Address tagged", "Removed at", "Reward amount"])
    const tokens = csv.find((r) => r[1] === "Kleros Tokens") as string[]
    assert.equal(tokens[2], "Gnosis Chain")
    assert.equal(tokens[4], new Date(1789000000 * 1000).toISOString())
  })

  it("fills the ATQ reports' Rewarded column and writes the ATQ send file", async () => {
    const { rewards, registered, absent, atqRewards } = scenario()
    await writeRemovalsOutputs("1", PERIOD, rewards, registered, absent, atqRewards)
    const reg = readCsv(file("1_atq_registered.csv"))
    assert.deepEqual(reg[0], ["Item ID", "Submission Time", "Resolution Time (registered)", "Requester", "Metadata", "Rewarded"])
    assert.equal(reg[1][5], "3000")
    assert.equal(reg[2][5], "", "a row without a requester is reported but not rewarded")
    const atqTx = readJson(file("1_atq_transactions.json"))
    assert.equal(atqTx.length, 1)
    assert.equal(BigNumber.from(atqTx[0].amount).toString(), utils.parseEther("3500").toString())
    const records = readJson(file("1_atq.json"))
    assert.deepEqual(records.map((r: { kind: string }) => r.kind), ["registered", "removed"])
  })

  it("writes empty but valid files for a period without removals", async () => {
    const manifest = await writeRemovalsOutputs("9", PERIOD, [], [], [], [])
    assert.deepEqual(readJson(file(manifest.transactionsFile)), [])
    assert.deepEqual(readJson(file(manifest.atqTransactionsFile)), [])
    assert.equal(manifest.removalCount, 0)
  })
})

describe("writeFetchOutputs", () => {
  const enriched = (overrides: Partial<EnrichedTag>): EnrichedTag => {
    const tag = makeTag(overrides)
    return { ...tag, chainCaip2: `eip155:${tag.chain}`, namespaceId: "eip155", txCount: 5, ...overrides }
  }

  it("writes the audit files, the generate inputs and the manifests", async () => {
    const evm = enriched({ chain: "1", tagAddress: "0xAbC0000000000000000000000000000000000001", txCount: 12 })
    const sameAddressOtherRegistry = enriched({ chain: "1", tagAddress: evm.tagAddress.toLowerCase(), registry: "tokens", txCount: 12 })
    const sol = enriched({ chain: SOLANA_CHAIN, tagAddress: solanaAddress("Fetched"), namespaceId: "solana", chainCaip2: `solana:${SOLANA_CHAIN}`, txCount: 99 })
    const manifest = await writeFetchOutputs("77", [evm, sameAddressOtherRegistry, sol], 3, PERIOD, { excludedCount: 4 })
    assert.equal(manifest.generateTagsFile, "77_generate_tags.json")
    assert.equal(manifest.includedCount, 3)
    assert.equal(manifest.droppedBySolanaHoldersCount, 3)
    assert.equal(manifest.excludedCount, 4)
    assert.equal(manifest.periodStart, "2026-09-01T00:00:00.000Z")
    const written = JSON.parse(JSON.stringify(manifest))
    assert.deepEqual(readJson(file("latest_fetch_manifest.json")), written)
    assert.deepEqual(readJson(file("77_fetch_manifest.json")), written)

    // one gas row per chain + address, EVM lowercase without 0x, Solana as is
    assert.deepEqual(readJson(file("77_generate_gas.json")), [
      { chain: "1", address: "abc0000000000000000000000000000000000001", tx_count: 12 },
      { chain: SOLANA_CHAIN, address: sol.tagAddress, tx_count: 99 },
    ])
    const tags = readJson(file("77_generate_tags.json"))
    assert.deepEqual(Object.keys(tags[0]).sort(), [
      "addressTagName",
      "chain",
      "id",
      "isTokenOnAddressTags",
      "latestRequestResolutionTime",
      "registry",
      "submitter",
      "tagAddress",
    ])
    assert.deepEqual(readJson(file("77_generate_input.json")), { tags, gas: readJson(file("77_generate_gas.json")) })
    assert.equal(readJson(file("77_full.json")).length, 3)
    const csv = readCsv(file("77_full.csv"))
    assert.equal(csv[0][9], "txn count")
    assert.equal(csv[1][2], "Address Tags")
  })
})

describe("writeFilterCheckOutput", () => {
  const row = (reason: FilterCheckRow["reason"]): FilterCheckRow => {
    const tag = makeTag()
    return { ...tag, reason }
  }

  it("lists every exclusion, then a summary whose rows add up to the total", async () => {
    const rows = [
      row("chain not configured for rewards"),
      row("token on address tags"),
      row("token on address tags"),
      row("erc-721 contract"),
    ]
    const out = await writeFilterCheckOutput("5", rows)
    assert.equal(out.csvFile, "5_filter_check.csv")
    const csv = readCsv(file(out.csvFile))
    const details = csv.filter((r) => r[0] === "detail")
    const summary = csv.filter((r) => r[0] === "summary")
    assert.equal(details.length, 4)
    assert.deepEqual(summary[0].slice(0, 3), ["summary", "TOTAL EXCLUDED", "4"])
    const perReason = summary.slice(1).reduce((acc, r) => acc + Number(r[2]), 0)
    assert.equal(perReason, 4, "every exclusion reason has a summary row")
    assert.deepEqual(
      out.summaryByReason.filter((s) => s.count > 0),
      [
        { reason: "chain not configured for rewards", count: 1 },
        { reason: "token on address tags", count: 2 },
        { reason: "erc-721 contract", count: 1 },
      ]
    )
  })
})
