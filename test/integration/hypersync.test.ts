import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { readdirSync } from "fs"
import { join } from "path"
import {
  countEvmTxsWithHypersync,
  getHypersyncHeight,
  hypersyncRequestsPerMinute,
  hypersyncUrl,
  HYPERSYNC_DEFINITION,
  preByzantiumSucceeded,
  requireEnvioApiToken,
  ScanFn,
  ScanTx,
} from "../../src/utils/hypersync-enrichment"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv, withEnv } from "../support/env"
import { freshDir, readJson, writeJson } from "../support/files"
import { startMockServer } from "../support/http"
import { evmAddress } from "../support/fixtures"

// A simulated chain for the HyperSync scan seam: transactions by block, pages
// limited in rows and blocks like the real server.
interface SimTx extends ScanTx {
  block: number
}
class HsChain {
  txs: SimTx[] = [] // sorted by block
  height: number
  rowsPerPage = 50
  blocksPerPage = 5000
  queries: { chainId: string; from: number; to: number; addresses: string[]; status?: number }[] = []
  failAt?: { block: number; times: number; error?: string } // fails once the scan reaches `block`
  constructor(height: number) {
    this.height = height
  }
  add(to: string, blocks: number[], fields: Partial<ScanTx> = {}): void {
    for (const block of blocks) this.txs.push({ to, block, status: 1, ...fields })
    this.txs.sort((a, b) => a.block - b.block)
  }
  scan: ScanFn = async (chainId, query: any) => {
    const filter = query.transactions[0]
    const addresses: string[] = filter.to
    const from: number = query.fromBlock
    const to: number = query.toBlock
    this.queries.push({ chainId, from, to, addresses, status: filter.status })
    if (this.failAt && from >= this.failAt.block && this.failAt.times > 0) {
      this.failAt.times--
      throw new Error(this.failAt.error || "HyperSync request failed")
    }
    const max = Math.min(this.rowsPerPage, query.maxNumTransactions || Infinity)
    const end = Math.min(to, from + this.blocksPerPage)
    const rows: ScanTx[] = []
    let next = end
    for (const tx of this.txs) {
      if (tx.block < from || tx.block >= end) continue
      if (!addresses.includes(String(tx.to).toLowerCase())) continue
      if (filter.status !== undefined && tx.status !== filter.status) continue
      if (rows.length >= max) {
        next = tx.block // the server ends a page at a block boundary
        while (rows.length > 0 && (rows[rows.length - 1] as SimTx).block === next) rows.pop()
        break
      }
      rows.push({ ...tx })
    }
    return { nextBlock: next, transactions: rows.map(({ to, status, gas, gasUsed, logsBloom }) => ({ to, status, gas, gasUsed, logsBloom })) }
  }
  getHeight = async () => this.height
  truth(address: string, below: number): number {
    return this.txs.filter((tx) => tx.to === address && tx.status === 1 && tx.block < below).length
  }
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let b = from; b < to; b += step) out.push(b)
  return out
}

const A = evmAddress(0xaa)
const B = evmAddress(0xbb)
const C = evmAddress(0xcc)

let logs: CapturedConsole
let restoreEnv: () => void
let cacheDir: string
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(() => {
  cacheDir = freshDir("hs-cache-")
  restoreEnv = setEnv({ TX_COUNT_CACHE: "on", TX_COUNT_CACHE_DIR: cacheDir, HYPERSYNC_REORG_MARGIN_BLOCKS: "200" })
  logs.clear()
})
afterEach(() => restoreEnv())

const count = (chain: HsChain, byChain: { [id: string]: string[] }, opts: object = {}) =>
  countEvmTxsWithHypersync(byChain, { scan: chain.scan, getHeight: chain.getHeight, concurrency: 3, ...opts })

describe("HyperSync counts", () => {
  it("counts successful transactions to each address, up to the pinned block", async () => {
    const chain = new HsChain(20199)
    chain.add(A, range(10, 20000, 7))
    chain.add(B, range(5, 20000, 13))
    chain.add(B, range(6, 20000, 50), { status: 0 }) // failed: not counted
    const res = await count(chain, { "10": [A.toUpperCase().replace("0X", "0x"), B, B] })
    const pin = 20199 + 1 - 200
    assert.deepEqual(res.counts["10"], { [A]: chain.truth(A, pin), [B]: chain.truth(B, pin) })
    const report = res.chains[0]
    assert.equal(report.toBlockExclusive, pin)
    assert.equal(report.archiveHeight, 20199)
    assert.equal(report.addresses, 2)
    assert.equal(report.scannedAddresses, 2)
    assert.equal(report.rows, chain.truth(A, pin) + chain.truth(B, pin))
    assert.equal(res.cacheDir, cacheDir)
  })

  it("gives invalid addresses 0, with a warning, and scans nothing for them", async () => {
    const chain = new HsChain(5000)
    const res = await count(chain, { "100": ["not-an-address", "0x123"] })
    assert.deepEqual(res.counts["100"], { "not-an-address": 0, "0x123": 0 })
    assert.equal(chain.queries.length, 0)
    assert.ok(logs.has("2 invalid address(es) get txCount 0"))
  })

  it("records the HyperEVM caveat in the report of chain 999", async () => {
    const chain = new HsChain(5000)
    chain.add(A, [10])
    const res = await count(chain, { "999": [A] })
    assert.match(res.chains[0].note || "", /user-signed transactions only/)
  })

  it("scans several chains, each with its own pin", async () => {
    const one = new HsChain(9000)
    one.add(A, range(0, 9000, 11))
    const res = await countEvmTxsWithHypersync(
      { "8453": [A], "42161": [A] },
      {
        scan: one.scan,
        getHeight: async (chainId) => (chainId === "8453" ? 9000 : 7000),
        toBlockByChain: { "42161": 3000 },
      }
    )
    assert.equal(res.counts["8453"][A], one.truth(A, 9001 - 200))
    assert.equal(res.counts["42161"][A], one.truth(A, 3000))
  })

  it("counts from a start block when asked (verification only, without the cache)", async () => {
    const chain = new HsChain(10000)
    chain.add(A, range(0, 10000, 10))
    const res = await count(chain, { "10": [A] }, { persist: false, fromBlockByChain: { "10": 4000 }, toBlockByChain: { "10": 6000 } })
    assert.equal(res.counts["10"][A], 200)
    await assert.rejects(count(chain, { "10": [A] }, { persist: true, fromBlockByChain: { "10": 1 } }), /verification only/)
    await assert.rejects(count(chain, { "10": [A] }, { persist: true, successOnly: false }), /verification only/)
  })

  it("counts failed transactions too with successOnly false", async () => {
    const chain = new HsChain(3000)
    chain.add(A, range(0, 1000, 10))
    chain.add(A, range(1, 1000, 10), { status: 0 })
    const res = await count(chain, { "10": [A] }, { persist: false, successOnly: false, toBlockByChain: { "10": 1000 } })
    assert.equal(res.counts["10"][A], 200)
  })

  it("refuses a pin outside the archive", async () => {
    const chain = new HsChain(1000)
    chain.add(A, [1])
    await assert.rejects(count(chain, { "10": [A] }, { toBlockByChain: { "10": 5000 } }), /outside HyperSync's archive \(height 1000\)/)
  })
})

describe("HyperSync cache and resume", () => {
  const cacheFile = () => readJson(join(cacheDir, "evm-hypersync-10.json"))

  it("caches each count with the block it covers, and later only scans what is new", async () => {
    const chain = new HsChain(10199)
    chain.add(A, range(0, 30000, 9))
    const first = await count(chain, { "10": [A] })
    assert.equal(first.counts["10"][A], chain.truth(A, 10000))
    assert.deepEqual(Object.keys(cacheFile().entries), [A])
    assert.equal(cacheFile().entries[A].toBlock, 10000)
    assert.equal(cacheFile().definition, HYPERSYNC_DEFINITION)

    chain.height = 20199
    chain.queries = []
    const second = await count(chain, { "10": [A, B] })
    assert.equal(second.counts["10"][A], chain.truth(A, 20000))
    assert.equal(second.counts["10"][B], 0)
    const forA = chain.queries.filter((q) => q.addresses.includes(A))
    assert.ok(forA.every((q) => q.from >= 10000), "A only tops up from its cached cutoff")
    assert.ok(chain.queries.some((q) => q.addresses.includes(B) && q.from === 0), "B, new, is scanned from block 0")
    assert.equal(second.chains[0].scannedAddresses, 2)

    chain.queries = []
    const third = await count(chain, { "10": [A] })
    assert.equal(third.counts["10"][A], chain.truth(A, 20000))
    assert.equal(chain.queries.length, 0, "nothing new: no request at all")
  })

  it("keeps one cutoff per chain: a lagging archive is waited for, not counted behind", async () => {
    const chain = new HsChain(10199)
    chain.add(A, range(0, 12000, 9))
    await count(chain, { "10": [A] })
    chain.height = 9000 // a lagging node
    await assert.rejects(count(chain, { "10": [A] }), /archive \(height 9000\) is behind the cached cutoff/)
  })

  it("resumes an interrupted scan from its checkpoint, counting nothing twice", async () => {
    const chain = new HsChain(40199)
    chain.add(A, range(0, 40000, 3))
    chain.add(B, range(1, 40000, 5))
    chain.failAt = { block: 25000, times: 1, error: "connection reset" }
    await assert.rejects(count(chain, { "10": [A, B] }, { concurrency: 1 }), /chain 10, blocks \d+\.\.\d+: connection reset/)
    const job = cacheFile().job
    assert.ok(job, "the unfinished scan is saved")
    const done = job.groups[0].segments.reduce((n: number, s: { next: number; from: number }) => n + (s.next - s.from), 0)
    assert.ok(done > 0 && done < 40000)
    chain.queries = []
    const res = await count(chain, { "10": [A, B] }, { concurrency: 1 })
    assert.equal(res.counts["10"][A], chain.truth(A, 40000))
    assert.equal(res.counts["10"][B], chain.truth(B, 40000))
    assert.ok(chain.queries.every((q) => q.from >= done - 5000), "the rerun did not start over")
    assert.equal(cacheFile().job, null)
  })

  it("checks every row of a page before counting any (no partial page in the cache)", async () => {
    const chain = new HsChain(10199)
    chain.add(A, range(0, 10000, 4))
    const stray = evmAddress(0xdd)
    let bad = true
    const scan: ScanFn = async (chainId, query: any) => {
      const res = await chain.scan(chainId, query)
      if (bad && query.fromBlock > 0) res.transactions.push({ to: stray })
      return res
    }
    await assert.rejects(
      countEvmTxsWithHypersync({ "10": [A] }, { scan, getHeight: chain.getHeight, concurrency: 1 }),
      new RegExp(`unexpected tx.to "${stray}"`)
    )
    bad = false
    const res = await countEvmTxsWithHypersync({ "10": [A] }, { scan, getHeight: chain.getHeight, concurrency: 1 })
    assert.equal(res.counts["10"][A], chain.truth(A, 10000))
  })

  it("splits long scans across workers and still counts exactly", async () => {
    const chain = new HsChain(200199)
    chain.rowsPerPage = 20
    chain.blocksPerPage = 2000
    chain.add(A, range(0, 200000, 37))
    chain.add(C, range(100, 200000, 101))
    const res = await count(chain, { "10": [A, C] }, { concurrency: 4 })
    assert.equal(res.counts["10"][A], chain.truth(A, 200000))
    assert.equal(res.counts["10"][C], chain.truth(C, 200000))
    const starts = new Set(chain.queries.map((q) => q.from))
    assert.equal(starts.size, chain.queries.length, "no block range was requested twice")
  })

  it("ignores a cache written with another definition", async () => {
    writeJson(join(cacheDir, "evm-hypersync-10.json"), {
      version: 1,
      definition: "something else",
      chainId: "10",
      entries: { [A]: { count: 999999, toBlock: 5000, updatedAt: "x" } },
    })
    const chain = new HsChain(5199)
    chain.add(A, range(0, 5000, 10))
    const res = await count(chain, { "10": [A] })
    assert.equal(res.counts["10"][A], chain.truth(A, 5000))
    assert.ok(logs.has("ignoring a cache written with another format or definition"))
  })

  it("writes nothing with TX_COUNT_CACHE=off", async () => {
    await withEnv({ TX_COUNT_CACHE: "off" }, async () => {
      const chain = new HsChain(5199)
      chain.add(A, [1, 2, 3])
      const res = await count(chain, { "10": [A] })
      assert.equal(res.counts["10"][A], 3)
      assert.equal(res.cacheDir, undefined)
    })
    assert.deepEqual(readdirSync(cacheDir), [])
  })

  it("stops on a page that ends past the requested block", async () => {
    const scan: ScanFn = async (_chainId, query: any) => ({ nextBlock: query.toBlock + 10, transactions: [] })
    await assert.rejects(
      countEvmTxsWithHypersync({ "10": [A] }, { scan, getHeight: async () => 5000, persist: false }),
      /nextBlock \d+ is past the requested end/
    )
  })
})

describe("Ethereum before Byzantium (no receipt status)", () => {
  const BYZANTIUM = 4370000

  it("counts a status-less transaction as successful when it left gas or emitted logs", () => {
    assert.equal(preByzantiumSucceeded({ gas: BigInt(50000), gasUsed: BigInt(21000) }), true)
    assert.equal(preByzantiumSucceeded({ gas: BigInt(50000), gasUsed: BigInt(50000), logsBloom: "0x" + "0".repeat(512) }), false)
    assert.equal(preByzantiumSucceeded({ gas: BigInt(50000), gasUsed: BigInt(50000), logsBloom: "0x" + "0".repeat(511) + "1" }), true)
    assert.equal(preByzantiumSucceeded({}), false)
  })

  it("adds the pre-Byzantium successes to the status = 1 count of chain 1", async () => {
    const chain = new HsChain(4400199)
    chain.blocksPerPage = 2000000
    chain.rowsPerPage = 1000
    const nullStatus = { status: undefined, gas: BigInt(90000) }
    chain.add(A, range(4000000, BYZANTIUM, 1000), { ...nullStatus, gasUsed: BigInt(30000) }) // 370 left gas: succeeded
    chain.add(A, range(4000001, BYZANTIUM, 2000), { ...nullStatus, gasUsed: BigInt(90000), logsBloom: "0x01" }) // 185 with logs: succeeded
    chain.add(A, range(4000002, BYZANTIUM, 5000), { ...nullStatus, gasUsed: BigInt(90000), logsBloom: "0x00" }) // 74 burnt all, no logs: failed
    chain.add(A, range(BYZANTIUM, 4400000, 100)) // 300 with status 1
    chain.add(A, range(BYZANTIUM + 1, 4400000, 300), { status: 0 }) // 100 failed
    const res = await count(chain, { "1": [A] })
    assert.equal(res.counts["1"][A], 370 + 185 + 300)
    assert.equal(res.chains[0].preByzantiumNullStatusRows, 370 + 185 + 74)
  })
})

describe("HyperSync settings and /height", () => {
  it("needs ENVIO_API_TOKEN, and builds chain URLs from the template", async () => {
    await withEnv({ ENVIO_API_TOKEN: " " }, () => assert.throws(() => requireEnvioApiToken(), /ENVIO_API_TOKEN is not set/))
    await withEnv({ ENVIO_API_TOKEN: "tok" }, () => assert.equal(requireEnvioApiToken(), "tok"))
    await withEnv({ HYPERSYNC_URL_TEMPLATE: undefined }, () => assert.equal(hypersyncUrl("8453"), "https://8453.hypersync.xyz"))
    await withEnv({ HYPERSYNC_URL_TEMPLATE: "http://local/{chainId}/" }, () => assert.equal(hypersyncUrl("10"), "http://local/10"))
    await withEnv({ HYPERSYNC_REQUESTS_PER_MINUTE: undefined }, () => assert.equal(hypersyncRequestsPerMinute(), 14))
    await withEnv({ HYPERSYNC_REQUESTS_PER_MINUTE: "0" }, () => assert.equal(hypersyncRequestsPerMinute(), 0))
  })

  it("reads a chain's archive height", async () => {
    const server = await startMockServer((req) => ({ body: { height: req.path === "/10/height" ? 123456 : 0 } }))
    await withEnv({ HYPERSYNC_URL_TEMPLATE: `${server.url}/{chainId}` }, async () => {
      assert.equal(await getHypersyncHeight("10"), 123456)
    })
    await server.close()
  })
})
