import { beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import {
  acquireTxCountCacheLock,
  readCacheFile,
  ThrottledWriter,
  txCountCacheDir,
  txCountCacheEnabled,
  writeCacheFile,
} from "../../src/utils/tx-count-cache"
import {
  acquireDisbursementLock,
  contentId,
  disbursementId,
  DisbursementRecord,
  disbursementsDir,
  listDisbursements,
  periodLabel,
  recordFileName,
  saveDisbursement,
} from "../../src/utils/disbursement-ledger"
import { sleep } from "../../src/utils/runtime-helpers"
import { setEnv, withEnv } from "../support/env"
import { freshDir, freshWorkdir } from "../support/files"

let dir: string
beforeEach(() => {
  freshWorkdir()
  dir = freshDir("cache-")
  setEnv({ TX_COUNT_CACHE: "on", TX_COUNT_CACHE_DIR: dir })
})

describe("tx-count cache settings", () => {
  it("is on unless TX_COUNT_CACHE says off, false, 0 or no", async () => {
    for (const value of [undefined, "", "on", "yes", "1"]) {
      await withEnv({ TX_COUNT_CACHE: value }, () => assert.equal(txCountCacheEnabled(), true, String(value)))
    }
    for (const value of ["off", "OFF", "false", "0", " no "]) {
      await withEnv({ TX_COUNT_CACHE: value }, () => assert.equal(txCountCacheEnabled(), false, value))
    }
  })

  it("lives in ~/.cache by default, outside files/, and expands ~", async () => {
    await withEnv({ TX_COUNT_CACHE_DIR: undefined }, () =>
      assert.equal(txCountCacheDir(), join(homedir(), ".cache", "tag-registry-rewards", "tx-counts"))
    )
    await withEnv({ TX_COUNT_CACHE_DIR: "~/counts" }, () => assert.equal(txCountCacheDir(), join(homedir(), "counts")))
    await withEnv({ TX_COUNT_CACHE_DIR: "relative/dir" }, () => assert.equal(txCountCacheDir(), resolve("relative/dir")))
    assert.ok(homedir().startsWith(process.env.HERMETIC_TMP as string), "tests never touch the real home")
  })
})

describe("tx-count cache files", () => {
  it("round-trips JSON, written atomically", () => {
    assert.equal(readCacheFile("missing.json"), null)
    writeCacheFile("data.json", { a: 1, nested: { b: [1, 2] } })
    assert.deepEqual(readCacheFile("data.json"), { a: 1, nested: { b: [1, 2] } })
    assert.deepEqual(readdirSync(dir), ["data.json"], "no temporary file left behind")
  })

  it("names a corrupt cache file and how to recover", () => {
    writeFileSync(join(dir, "broken.json"), "{ not json")
    assert.throws(() => readCacheFile("broken.json"), /broken\.json is not valid JSON.*delete it to recount from scratch/)
  })

  it("reads and writes nothing when the cache is off", async () => {
    writeCacheFile("data.json", { a: 1 })
    await withEnv({ TX_COUNT_CACHE: "off" }, () => {
      assert.equal(readCacheFile("data.json"), null)
      writeCacheFile("other.json", { b: 2 })
    })
    assert.ok(!existsSync(join(dir, "other.json")))
  })

  it("coalesces frequent checkpoints, and flush writes the latest", async () => {
    const writer = new ThrottledWriter(10000)
    let version = 0
    writer.write("k", "throttled.json", () => ({ version: ++version }))
    assert.deepEqual(readCacheFile("throttled.json"), { version: 1 }, "the first write goes out at once")
    writer.write("k", "throttled.json", () => ({ version: ++version }))
    writer.write("k", "throttled.json", () => ({ version: ++version }))
    assert.deepEqual(readCacheFile("throttled.json"), { version: 1 }, "later writes wait")
    writer.flush()
    assert.deepEqual(readCacheFile("throttled.json"), { version: 2 }, "only the latest pending state is built")
    const fast = new ThrottledWriter(1)
    fast.write("x", "fast.json", () => 1)
    await sleep(5)
    fast.write("x", "fast.json", () => 2)
    assert.equal(readCacheFile("fast.json"), 2)
  })
})

describe("one run at a time (lock, fail closed)", () => {
  const lockPath = () => join(dir, ".lock")

  it("takes a free lock and releases it, leaving nothing behind", () => {
    const release = acquireTxCountCacheLock()
    assert.equal(readFileSync(lockPath(), "utf8"), String(process.pid))
    release()
    release() // twice is harmless
    assert.deepEqual(readdirSync(dir), [])
    const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].reduce((n, s) => n + process.listenerCount(s), 0)
    assert.equal(listeners, 0, "no signal handler left")
  })

  it("refuses a lock held by a live run", () => {
    writeFileSync(lockPath(), String(process.ppid))
    assert.throws(() => acquireTxCountCacheLock(), new RegExp(`\\[tx-count-cache\\] Another run \\(pid ${process.ppid}\\) is using`))
    assert.equal(readFileSync(lockPath(), "utf8"), String(process.ppid))
  })

  it("refuses a stale lock and leaves it for a person to delete", () => {
    writeFileSync(lockPath(), "999999")
    assert.throws(() => acquireTxCountCacheLock(), /held by pid 999999, which is no longer running.*delete that file and rerun/)
    assert.equal(readFileSync(lockPath(), "utf8"), "999999")
  })

  it("refuses an empty lock (a run killed while creating it, or one starting now)", () => {
    writeFileSync(lockPath(), "")
    assert.throws(() => acquireTxCountCacheLock(), /held by no recorded pid/)
    assert.ok(existsSync(lockPath()))
  })

  it("never removes another run's lock on release", () => {
    const release = acquireTxCountCacheLock()
    writeFileSync(lockPath(), String(process.ppid)) // another run took over
    release()
    assert.equal(readFileSync(lockPath(), "utf8"), String(process.ppid))
  })

  it("needs no lock with the cache off", async () => {
    await withEnv({ TX_COUNT_CACHE: "off" }, () => acquireTxCountCacheLock()())
    assert.deepEqual(readdirSync(dir), [])
  })

  it("guards the disbursement ledger the same way, with its own label", () => {
    const release = acquireDisbursementLock()
    assert.throws(() => acquireDisbursementLock(), /\[disbursements\] .*\.lock is held by pid/)
    release()
    acquireDisbursementLock()()
  })
})

describe("disbursement ledger", () => {
  // A record as send writes it: its ids computed from its transfers, kind and period.
  const record = (overrides: Partial<DisbursementRecord> = {}): DisbursementRecord => {
    const r: DisbursementRecord = {
      version: 1,
      id: "",
      contentId: "",
      file: "1.json",
      fileSha256: "00",
      kind: "submissions",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      chainId: 100,
      token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
      from: "0x0000000000000000000000000000000000000001",
      status: "completed",
      total: "1",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      transfers: [{ recipient: "0x0000000000000000000000000000000000000002", amount: "1", status: "confirmed" }],
      ...overrides,
    }
    r.contentId = contentId(r.chainId, r.token, r.transfers)
    r.id = disbursementId(r.contentId, r.kind, r.periodStart, r.periodEnd)
    return r
  }
  const AUGUST = { periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" }

  it("identifies what a payout pays: chain, token, recipients and amounts, in any order or casing", () => {
    const a = [
      { recipient: "0xAbC0000000000000000000000000000000000001", amount: "5" },
      { recipient: "0x0000000000000000000000000000000000000002", amount: "7" },
    ]
    const b = [
      { recipient: "0x0000000000000000000000000000000000000002", amount: "7" },
      { recipient: "0xabc0000000000000000000000000000000000001", amount: "5" },
    ]
    const token = "0xcb3231aBA3b451343e0Fddfc45883c842f223846"
    assert.equal(contentId(100, token, a), contentId(100, token.toLowerCase(), b))
    assert.notEqual(contentId(100, token, a), contentId(10200, token, a), "another chain is another payout")
    assert.notEqual(contentId(100, token, a), contentId(100, token, [a[0], { ...a[1], amount: "8" }]))
    assert.match(contentId(100, token, a), /^[0-9a-f]{64}$/)
  })

  it("tells payouts apart by kind and period too: identical capped files recur", () => {
    const content = contentId(100, "0xcb3231aBA3b451343e0Fddfc45883c842f223846", [{ recipient: "0x0000000000000000000000000000000000000002", amount: "7" }])
    const sept = disbursementId(content, "removals", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")
    assert.equal(sept, disbursementId(content, "removals", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"))
    assert.notEqual(sept, disbursementId(content, "removals", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"))
    assert.notEqual(sept, disbursementId(content, "atq", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"))
    assert.notEqual(sept, disbursementId(content, "unknown"))
  })

  it("labels periods by month when whole, by dates otherwise", () => {
    assert.equal(periodLabel("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"), "2026-09")
    assert.equal(periodLabel("2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"), "2026-12")
    assert.equal(periodLabel("2026-09-01T00:00:00.000Z", "2026-09-16T00:00:00.000Z"), "2026-09-01_2026-09-16")
    assert.equal(periodLabel(undefined, undefined), "unknown")
    const september = record()
    assert.equal(recordFileName(september), `2026-09-submissions-${september.id.slice(0, 12)}.json`)
    const unknown = record({ periodStart: undefined, periodEnd: undefined, kind: "atq" })
    assert.equal(recordFileName(unknown), `unknown-atq-${unknown.id.slice(0, 12)}.json`)
  })

  it("saves records durably and lists them oldest first", () => {
    assert.deepEqual(listDisbursements(), [])
    saveDisbursement(record({ ...AUGUST, createdAt: "2026-10-07T00:00:00.000Z" }))
    saveDisbursement(record())
    const records = listDisbursements()
    assert.deepEqual(records.map((r) => r.periodStart), ["2026-09-01T00:00:00.000Z", AUGUST.periodStart])
    assert.equal(disbursementsDir(), resolve("disbursements"))
    assert.ok(readdirSync(disbursementsDir()).every((name) => name.endsWith(".json")), "no temporary file left")
    assert.ok(records[0].updatedAt > "2026-10-06T00:00:00.000Z", "updatedAt is refreshed on save")
  })

  it("stops on a record it cannot trust", () => {
    mkdirSync(disbursementsDir(), { recursive: true })
    writeFileSync(join(disbursementsDir(), "x.json"), JSON.stringify({ version: 2 }))
    assert.throws(() => listDisbursements(), /is not a disbursement record/)
  })

  it("stops on a record whose transfers, kind or period changed after it was written", () => {
    const path = saveDisbursement(record())
    const original = JSON.parse(readFileSync(path).toString())
    const changes: [string, object][] = [
      ["a recipient", { transfers: [{ ...original.transfers[0], recipient: "0x0000000000000000000000000000000000000bad" }] }],
      ["an amount", { transfers: [{ ...original.transfers[0], amount: "2" }] }],
      ["the kind", { kind: "atq" }],
      ["the period", AUGUST],
      ["the content id", { contentId: "00".repeat(32) }],
      ["the chain", { chainId: 10200 }],
    ]
    for (const [what, change] of changes) {
      writeFileSync(path, JSON.stringify({ ...original, ...change }))
      assert.throws(() => listDisbursements(), /does not match its own ids.*Restore it from git before sending/s, what)
    }
    writeFileSync(path, JSON.stringify({ ...original, status: "in-progress", transfers: [{ ...original.transfers[0], status: "pending" }] }))
    assert.equal(listDisbursements().length, 1, "progress is no change of what it pays")
  })

  it("honours DISBURSEMENTS_DIR", async () => {
    const elsewhere = freshDir("ledger-")
    await withEnv({ DISBURSEMENTS_DIR: elsewhere }, () => {
      saveDisbursement(record())
      assert.equal(listDisbursements().length, 1)
    })
    assert.equal(readdirSync(elsewhere).length, 1)
  })
})
