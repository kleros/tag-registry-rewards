import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { existsSync, writeFileSync } from "fs"
import { join } from "path"
import { buildCurateSnapshot, updateCurateIndex, writeCurateSnapshot } from "../../src/utils/curate-document"
import { documentRoutine } from "../../src/document-routine"
import { AtqRewardRecord, CurateIndexEntry, RewardRecord } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv, withEnv } from "../support/env"
import { freshWorkdir, readJson, writeJson } from "../support/files"
import { evmAddress } from "../support/fixtures"

const PERIOD = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") }

const record = (overrides: Partial<RewardRecord> = {}): RewardRecord => ({
  recipient: evmAddress(1),
  id: "0x01@0xreg",
  registry: "addressTags",
  chain: "1",
  chainName: "Ethereum Mainnet",
  tagAddress: evmAddress(0x100),
  amount: "1000",
  ...overrides,
})

const atqRecord = (overrides: Partial<AtqRewardRecord> = {}): AtqRewardRecord => ({
  recipient: evmAddress(2),
  id: "0xa1:registered",
  kind: "registered",
  itemID: "0xa1",
  metadata: "x",
  amount: "300",
  ...overrides,
})

let logs: CapturedConsole
let work: string
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(() => {
  work = freshWorkdir()
  logs.clear()
})
const files = (name: string) => join(work, "files", name)

describe("buildCurateSnapshot", () => {
  it("merges every reward line per recipient, whatever the address casing", () => {
    const checksummed = "0xAbCd000000000000000000000000000000000001"
    const snapshot = buildCurateSnapshot(
      "2026-09",
      PERIOD,
      [record({ recipient: checksummed, amount: "1000" }), record({ recipient: evmAddress(3), registry: "tokens", amount: "5" })],
      [record({ recipient: checksummed.toLowerCase(), registry: "domains", amount: "20" })],
      [atqRecord({ recipient: checksummed, amount: "300" })]
    )
    const key = checksummed.toLowerCase()
    assert.deepEqual(Object.keys(snapshot.recipients).sort(), [evmAddress(3), key].sort())
    const merged = snapshot.recipients[key]
    assert.equal(merged.total, "1320")
    assert.equal(merged.submissions.length, 1)
    assert.equal(merged.removals[0].registry, "Domains")
    assert.deepEqual(merged.atq[0], { registry: "atq", chain: "", chainName: "registered", tagAddress: "0xa1", amount: "300" })
    assert.deepEqual(snapshot.totals, { submissions: "1005", removals: "20", atq: "300", total: "1325", recipientCount: 2 })
    assert.deepEqual(snapshot.entryCounts, { submissions: 2, removals: 1, atq: 1, total: 4 })
  })

  it("uses the published display names, the period, chain and token of the run", () => {
    const snapshot = buildCurateSnapshot("2026-09", PERIOD, [record({ registry: "tokens" })], [], [])
    assert.equal(snapshot.schema, "curate-rewards/v1")
    assert.deepEqual(snapshot.period, { label: "2026-09", start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" })
    assert.equal(snapshot.chainId, 100)
    assert.deepEqual(snapshot.token, { symbol: "PNK", address: process.env.PNK })
    assert.equal(snapshot.recipients[evmAddress(1)].submissions[0].registry, "Kleros Tokens")
  })

  it("publishes an unknown registry under its raw key and warns once", () => {
    const snapshot = buildCurateSnapshot(
      "2026-09",
      PERIOD,
      [record({ registry: "mystery" as RewardRecord["registry"] }), record({ registry: "mystery" as RewardRecord["registry"] })],
      [],
      []
    )
    assert.equal(snapshot.recipients[evmAddress(1)].submissions[0].registry, "mystery")
    assert.equal(logs.lines.filter((l) => l.includes('Registry "mystery" has no display name')).length, 1)
  })

  it("is empty but valid for a period without rewards", () => {
    const snapshot = buildCurateSnapshot("2026-09", PERIOD, [], [], [])
    assert.deepEqual(snapshot.totals, { submissions: "0", removals: "0", atq: "0", total: "0", recipientCount: 0 })
  })
})

describe("curate index", () => {
  const entry = (period: string, overrides: Partial<CurateIndexEntry> = {}): CurateIndexEntry => ({
    period,
    cid: null,
    url: null,
    file: `curate-rewards-${period}.json`,
    generatedAt: "2026-10-01T00:00:00.000Z",
    total: "1",
    recipientCount: 1,
    ...overrides,
  })

  it("upserts a period and keeps the newest first", () => {
    updateCurateIndex(entry("2026-08"))
    updateCurateIndex(entry("2026-10"))
    updateCurateIndex(entry("2026-09"))
    const index = updateCurateIndex(entry("2026-09", { total: "2" }))
    assert.deepEqual(index.map((e) => [e.period, e.total]), [["2026-10", "1"], ["2026-09", "2"], ["2026-08", "1"]])
    assert.deepEqual(readJson(files("curate-rewards-index.json")), index)
  })

  it("starts over from an unreadable index", () => {
    writeFileSync(join(work, "files-placeholder"), "")
    writeJson(files("curate-rewards-index.json"), [entry("2026-07")])
    writeFileSync(files("curate-rewards-index.json"), "{ broken")
    assert.deepEqual(updateCurateIndex(entry("2026-09")).map((e) => e.period), ["2026-09"])
  })

  it("writes the snapshot as curate-rewards-<period>.json", () => {
    const out = writeCurateSnapshot(buildCurateSnapshot("2026-09", PERIOD, [], [], []))
    assert.equal(out.file, "curate-rewards-2026-09.json")
    assert.equal(readJson(files(out.file)).period.label, "2026-09")
  })
})

describe("documentRoutine", () => {
  const writeRun = (
    opts: { fetchPeriod?: string; generatePeriod?: string; removalsPeriod?: string; generatedBeforeFetch?: boolean } = {}
  ) => {
    writeJson(files("100_rewards.json"), [record()])
    writeJson(files("200_removals.json"), [record({ recipient: evmAddress(5), registry: "domains" })])
    writeJson(files("200_atq.json"), [atqRecord()])
    writeJson(files("300_removals.json"), [record({ recipient: evmAddress(6), registry: "tokens" })])
    writeJson(files("300_atq.json"), [atqRecord({ recipient: evmAddress(6) })])
    writeJson(files("latest_fetch_manifest.json"), {
      runId: "50",
      generatedAt: "2026-10-02T00:00:00.000Z",
      periodStart: `${opts.fetchPeriod || "2026-09"}-01T00:00:00.000Z`,
    })
    writeJson(files("latest_generate_manifest.json"), {
      runId: "100",
      generatedAt: opts.generatedBeforeFetch ? "2026-10-01T00:00:00.000Z" : "2026-10-03T00:00:00.000Z",
      ...(opts.generatePeriod ? { periodStart: `${opts.generatePeriod}-01T00:00:00.000Z` } : {}),
      rewardsFile: "100_rewards.json",
      transactionsFile: "100.json",
    })
    writeJson(files("latest_removals_manifest.json"), {
      runId: "200",
      periodStart: `${opts.removalsPeriod || "2026-09"}-01T00:00:00.000Z`,
      removalsJsonFile: "200_removals.json",
      atqRewardsJsonFile: "200_atq.json",
    })
  }
  const run = (opts: { submissionsFile?: string; removalsFile?: string; atqFile?: string } = {}) =>
    documentRoutine({ period: PERIOD, periodLabel: "2026-09", ...opts })

  it("merges the latest generate and removals runs, writes the index and the URL list", async () => {
    writeRun()
    const entry = await run()
    assert.equal(entry.period, "2026-09")
    assert.equal(entry.recipientCount, 3)
    assert.equal(entry.total, "2300")
    assert.equal(entry.cid, null)
    const snapshot = readJson(files("curate-rewards-2026-09.json"))
    assert.equal(snapshot.entryCounts.total, 3)
    assert.deepEqual(readJson(files("curate-rewards-index.json")).map((e: CurateIndexEntry) => e.period), ["2026-09"])
    assert.deepEqual(readJson(files("curate-rewards-index.urls.json")), [], "entries without an IPFS url are left out")
    assert.ok(logs.has("MERGE this period's entry/URL"))
  })

  it("warns when the latest runs belong to another period, or generate predates fetch", async () => {
    writeRun({ fetchPeriod: "2026-08", removalsPeriod: "2026-07", generatedBeforeFetch: true })
    await run()
    assert.ok(logs.has("latest removals were computed for 2026-07 but documenting 2026-09"))
    assert.ok(logs.has("latest fetch (submissions) was for 2026-08 but documenting 2026-09"))
    assert.ok(logs.has("latest generate output predates the latest fetch"))
  })

  it("checks the period generate recorded, not the latest fetch's, when it recorded one", async () => {
    writeRun({ fetchPeriod: "2026-10", generatePeriod: "2026-09" })
    await run()
    assert.ok(!logs.has("(submissions) was for"), "September's rewards, whatever was fetched since")
  })

  it("warns when the rewards generate built are for another period", async () => {
    writeRun({ generatePeriod: "2026-08" })
    await run()
    assert.ok(logs.has("latest generate (submissions) was for 2026-08 but documenting 2026-09"))
  })

  it("pairs an explicit removals file with its own ATQ file", async () => {
    writeRun()
    const entry = await run({ removalsFile: "300_removals.json" })
    const snapshot = readJson(files("curate-rewards-2026-09.json"))
    assert.equal(snapshot.recipients[evmAddress(6)].atq.length, 1, "300_atq.json, not the latest run's")
    assert.equal(entry.recipientCount, 2)
  })

  it("warns when an explicit removals file has no derivable ATQ sibling", async () => {
    writeRun()
    writeJson(files("custom-removals.json"), [record()])
    await run({ removalsFile: "custom-removals.json" })
    assert.ok(logs.has(/doesn't match the <runId>_removals.json pattern/))
  })

  it("refuses a send transactions file in place of a rewards record file", async () => {
    writeRun()
    writeJson(files("100.json"), [{ amount: { type: "BigNumber", hex: "0x01" }, recipient: evmAddress(1) }])
    await assert.rejects(run({ submissionsFile: "100.json" }), /\[document\] 100\.json\[0\] has no string "registry".*not the send transactions file/)
    writeJson(files("bad-amount.json"), [record({ amount: "1.5" })])
    await assert.rejects(run({ submissionsFile: "bad-amount.json" }), /amount is not a decimal wei string/)
    writeJson(files("not-array.json"), { records: [] })
    await assert.rejects(run({ submissionsFile: "not-array.json" }), /is not a JSON array/)
  })

  it("documents what exists, with warnings, when inputs are missing", async () => {
    const entry = await run({ submissionsFile: "nope.json", removalsFile: "gone_removals.json" })
    assert.equal(entry.recipientCount, 0)
    assert.ok(logs.has("Submissions file nope.json not found"))
    assert.ok(logs.has("Removals file gone_removals.json not found"))
    assert.ok(logs.has("ATQ file gone_atq.json not found"))
  })
})

describe("IPFS upload", () => {
  const CLIENT = require.resolve("@filebase/client")
  const IPFS = require.resolve("../../src/utils/file-to-ipfs")
  const DOCUMENT = require.resolve("../../src/document-routine")
  let restore: () => void
  let stored: { name: string; type: string; content: string }[]
  let fail: Error | null

  beforeEach(() => {
    stored = []
    fail = null
    class File {
      constructor(readonly parts: Buffer[], readonly name: string, readonly options: { type: string }) {}
    }
    class FilebaseClient {
      constructor(readonly opts: { token: string }) {
        assert.equal(opts.token, "test-token")
      }
      async storeDirectory(list: File[]) {
        if (fail) throw fail
        for (const f of list) stored.push({ name: f.name, type: f.options.type, content: Buffer.concat(f.parts).toString() })
        return "bafytestcid"
      }
    }
    require.cache[CLIENT] = { id: CLIENT, filename: CLIENT, loaded: true, exports: { FilebaseClient, File } } as unknown as NodeModule
    delete require.cache[IPFS]
    delete require.cache[DOCUMENT]
    restore = setEnv({ FILEBASE_TOKEN: "test-token", IPFS_GATEWAY: "https://gateway.example/ipfs//" })
  })
  afterEach(() => {
    restore()
    delete require.cache[CLIENT]
    delete require.cache[IPFS]
    delete require.cache[DOCUMENT]
  })

  it("skips the upload without FILEBASE_TOKEN", async () => {
    await withEnv({ FILEBASE_TOKEN: undefined }, async () => {
      const { uploadToIpfs } = require(IPFS)
      assert.equal(await uploadToIpfs(files("x.json")), null)
      assert.ok(logs.has("FILEBASE_TOKEN not set"))
    })
  })

  it("uploads the snapshot and links it through the gateway, trailing slashes trimmed", async () => {
    const { uploadToIpfs } = require(IPFS)
    writeJson(files("curate-rewards-2026-09.json"), { hello: "ipfs" })
    const result = await uploadToIpfs(`./files/curate-rewards-2026-09.json`)
    assert.deepEqual(result, { cid: "bafytestcid", url: "https://gateway.example/ipfs/bafytestcid/curate-rewards-2026-09.json" })
    assert.equal(stored[0].name, "curate-rewards-2026-09.json")
    assert.equal(stored[0].type, "application/json")
    assert.deepEqual(JSON.parse(stored[0].content), { hello: "ipfs" })
  })

  it("records the IPFS link in the index and the URL list", async () => {
    const { documentRoutine: documentWithUpload } = require(DOCUMENT)
    const entry = await documentWithUpload({ period: PERIOD, periodLabel: "2026-09", submissionsFile: "none.json" })
    assert.equal(entry.cid, "bafytestcid")
    assert.deepEqual(readJson(files("curate-rewards-index.urls.json")), [entry.url])
  })

  it("fails the run, leaving the index untouched, when a configured upload fails", async () => {
    fail = new Error("filebase is down")
    const { documentRoutine: documentWithUpload } = require(DOCUMENT)
    await assert.rejects(
      documentWithUpload({ period: PERIOD, periodLabel: "2026-09", submissionsFile: "none.json" }),
      /filebase is down/
    )
    assert.ok(existsSync(files("curate-rewards-2026-09.json")), "the local snapshot is written first")
    assert.ok(!existsSync(files("curate-rewards-index.json")), "the index is not updated")
  })
})
