import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { createHash } from "crypto"
import { BigNumber } from "ethers"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRewards } from "../../src/reward-builder"
import buildCsv from "../../src/csv"
import { documentRoutine } from "../../src/document-routine"
import { GasDune, Tag } from "../../src/types"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { FIXTURES, freshWorkdir, readGzipJson, readJson, writeJson } from "../support/files"

// The published September 2026 payout (see test/fixtures/september-2026/README.md):
// the current code must reproduce it to the wei.
const DIR = join(FIXTURES, "september-2026")
// base64 digests: 64-character hex strings look like private keys to secretlint
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("base64")

let logs: CapturedConsole
let restoreEnv: () => void
before(() => {
  logs = captureConsole()
  restoreEnv = setEnv({ ...readJson(join(DIR, "config.json")), FILEBASE_TOKEN: undefined })
})
after(() => {
  restoreEnv()
  logs.restore()
})

describe("golden: September 2026", () => {
  it("generate reproduces the published submissions payout to the wei", async () => {
    const work = freshWorkdir()
    const tags = readGzipJson<Tag[]>(join(DIR, "generate_tags.json.gz"))
    const gas = readGzipJson<GasDune[]>(join(DIR, "generate_gas.json.gz"))
    assert.equal(tags.length, 1088)

    const rewards = await buildRewards(BigNumber.from(process.env.STIPEND), BigNumber.from(process.env.MAX_REWARD), tags, gas)
    await buildCsv(rewards)

    const manifest = readJson(join(work, "files", "latest_generate_manifest.json"))
    const files = join(work, "files")
    assert.deepEqual(
      readJson(join(files, manifest.transactionsFile)),
      readJson(join(DIR, "transactions.expected.json")),
      "the send file differs from the published one"
    )
    const hashes = readJson(join(DIR, "expected-hashes.json"))
    assert.equal(sha256(join(files, manifest.rewardsFile)), hashes["rewards.json"], "per-entry rewards changed")
    assert.equal(sha256(join(files, `${manifest.runId}.csv`)), hashes["rewards.csv"], "the rewards CSV changed")
    assert.equal(sha256(join(files, `${manifest.runId}_tx.csv`)), hashes["transactions.csv"], "the transactions CSV changed")

    const total = rewards.reduce((acc, r) => acc.add(r.amount), BigNumber.from(0))
    assert.equal(total.toString(), "257298629851559168631808")
  })

  it("document reproduces the published IPFS snapshot", async () => {
    const work = freshWorkdir()
    const tags = readGzipJson<Tag[]>(join(DIR, "generate_tags.json.gz"))
    const gas = readGzipJson<GasDune[]>(join(DIR, "generate_gas.json.gz"))
    await buildCsv(await buildRewards(BigNumber.from(process.env.STIPEND), BigNumber.from(process.env.MAX_REWARD), tags, gas))
    const files = join(work, "files")
    writeJson(join(files, "1790985008041_removals.json"), readGzipJson(join(DIR, "removals.json.gz")))
    writeJson(join(files, "1790985008041_atq.json"), readGzipJson(join(DIR, "atq.json.gz")))

    const entry = await documentRoutine({
      period: { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") },
      periodLabel: "2026-09",
      removalsFile: "1790985008041_removals.json",
    })

    const snapshot = readJson(join(files, "curate-rewards-2026-09.json"))
    delete snapshot.generatedAt
    assert.deepEqual(snapshot, readGzipJson(join(DIR, "curate-rewards-2026-09.expected.json.gz")))
    assert.equal(entry.total, "301298629851559168631808")
    assert.equal(entry.recipientCount, 9)
    assert.equal(entry.cid, null, "no upload without FILEBASE_TOKEN")
  })
})
