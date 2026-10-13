import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockChain, newChain, slotsFor } from "../support/solana"
import {
  countSolana,
  failsWith,
  freshCache,
  readSolanaCache,
  reportOf,
  scenarioAddress as addr,
  scenarioEnv,
  seedCache,
  solanaTag as tag,
} from "../support/solana-scenarios"

// Solana counts against a simulated chain whose URLs fail the ways real
// providers do (scenarios A–T of the PR #27 audits). Every count must be the
// exact truth, or for sampled ranges an unbiased estimate close to it.

let logs: CapturedConsole
let restoreEnv: () => void
const chains: MockChain[] = []
const chain = async (urls = 2) => {
  const c = await newChain(urls)
  chains.push(c)
  return c
}
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(() => {
  restoreEnv = scenarioEnv()
  logs.clear()
})
afterEach(async () => {
  restoreEnv()
  while (chains.length) await (chains.pop() as MockChain).stop()
})
const onPlanned = (fn: () => void) => logs.onLine("SOLANA_COUNT_MODE=auto:", fn)

describe("Solana counts: providers answering wrong", () => {
  it("A: a URL's newest page stops short (its long-term storage lookup failed)", async () => {
    const c = await chain()
    const a = addr("A")
    c.addHistory(a, slotsFor(2500, 500000, 1500000, 0, 1))
    c.faults[0].floor = { [a]: 1300000 }
    freshCache()
    const res = await countSolana(c, [tag(a)], [400, 20]) // URL 1 slow, so URL 0 answers first
    assert.equal(reportOf(res, a).successful, c.ok(a).ok)
  })

  it("B: a URL answers [] for the newest page of an address with a cached count", async () => {
    const c = await chain()
    const b = addr("B")
    c.addHistory(b, slotsFor(3000, 100000, 1000000, 0, 2))
    const old = c.histories[b]
    const base = c.ok(b)
    const dir = freshCache()
    seedCache(dir, {
      entries: { [b]: { successful: base.ok, failed: base.total - base.ok, newestSig: old[0].signature, newestSlot: old[0].slot, method: "exact", updatedAt: "x" } },
    })
    c.addHistory(b, slotsFor(800, 1500000, 1900000, 0, 3))
    c.faults[0].emptyNewest = new Set([b])
    const res = await countSolana(c, [tag(b)], [400, 20])
    assert.equal(reportOf(res, b).successful, c.ok(b).ok)
  })

  it("O: two of three URLs answer [] for the newest page of a cached address", async () => {
    const c = await chain(3)
    const b = addr("Q")
    c.addHistory(b, slotsFor(3000, 100000, 1000000, 0, 16))
    const old = c.histories[b]
    const base = c.ok(b)
    const dir = freshCache()
    seedCache(dir, {
      entries: { [b]: { successful: base.ok, failed: base.total - base.ok, newestSig: old[0].signature, newestSlot: old[0].slot, method: "exact", updatedAt: "x" } },
    })
    c.addHistory(b, slotsFor(800, 1500000, 1900000, 0, 17))
    c.faults[0].emptyNewest = new Set([b])
    c.faults[1].emptyNewest = new Set([b])
    const res = await countSolana(c, [tag(b)], [400, 300, 20])
    assert.equal(reportOf(res, b).successful, c.ok(b).ok)
  })

  it("C: a URL wrongly says 'nothing below' during the history-start search", async () => {
    const c = await chain()
    const a = addr("C")
    c.addHistory(a, slotsFor(60000, 200000, 1800000, 0, 4))
    c.faults[0].floor = { [a]: 1000000 }
    freshCache()
    const res = await countSolana(c, [tag(a)], [400, 20])
    const line = logs.lines.find((l) => l.includes(`${a}: ~`)) || ""
    const m = /in slots (\d+)\.\./.exec(line)
    assert.ok(m, `no sampling line for ${a}`)
    assert.ok(Number(m[1]) <= 200000, `sampled from slot ${m[1]}, but the history starts at 200000`)
    const err = Math.abs(reportOf(res, a).successful / c.ok(a).ok - 1)
    assert.ok(err < 0.35, `${(err * 100).toFixed(0)}% off`)
  })

  it("L: a sample window's boundary sits where no URL has blocks", async () => {
    const c = await chain()
    const a = addr("L")
    c.addHistory(a, slotsFor(40000, 300000, 1900000, 0, 12))
    for (const f of c.faults) f.missingBlocks = [1000000, 1200000]
    freshCache()
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    const err = Math.abs(got.successful / c.ok(a).ok - 1)
    assert.ok(err < 0.35, `${got.method} ~${got.successful} vs ${c.ok(a).ok}`)
  })

  it("T: getBlock fails everywhere: the sampler stops instead of paging from the newest signature", async () => {
    const c = await chain()
    const a = addr("T")
    c.addHistory(a, slotsFor(40000, 300000, 1900000, 0, 23))
    freshCache()
    onPlanned(() => {
      for (const f of c.faults) f.missingBlocks = [0, 3000000]
    })
    await assert.rejects(countSolana(c, [tag(a)]), /no RPC URL returned a block between slot \d+ and the tip/)
  })
})

describe("Solana counts: modes and sizes", () => {
  it("D: a small range is listed exactly after the quick map", async () => {
    const c = await chain()
    const a = addr("D")
    c.addHistory(a, slotsFor(3000, 1000000, 1900000, 0, 5))
    freshCache()
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
    assert.ok((c.calls.getSignaturesForAddress || 0) + (c.calls.getBlock || 0) < 200, "the quick map spares the full one")
  })

  it("N: one URL only: the history start is found and the count is exact", async () => {
    const c = await chain(1)
    const a = addr("N")
    c.addHistory(a, slotsFor(3000, 1000000, 1900000, 0, 18))
    freshCache()
    assert.equal(reportOf(await countSolana(c, [tag(a)]), a).successful, c.ok(a).ok)
  })

  it("M: the chain moves on while planning and sampling run", async () => {
    const c = await chain()
    const a = addr("M")
    c.tip = 1500000
    c.addHistory(a, slotsFor(40000, 300000, 1490000, 0, 13))
    // the run reads its tip with the 3rd getSlot (after one key check per URL); then new activity
    c.onGetSlot = (n) => {
      if (n !== 3) return
      c.addHistory(a, slotsFor(5000, 1500000, 1600000, 0, 14))
      c.tip = 1700000
    }
    let sampling = 0
    onPlanned(() => {
      sampling = c.calls[`gsfa:${a}`] || 0
      c.addHistory(a, slotsFor(30000, 1700000, 1900000, 0, 15))
      c.tip = 2000000
    })
    freshCache()
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    const pagesWhileSampling = (c.calls[`gsfa:${a}`] || 0) - sampling
    const truth = c.ok(a, 1600000).ok
    assert.ok(pagesWhileSampling < 150, `${pagesWhileSampling} pages while sampling: windows must be anchored, not paged from the live tip`)
    assert.ok(Math.abs(got.successful / truth - 1) < 0.35, `~${got.successful} vs ${truth}`)
  })

  it("R: a listing abandoned at its page cap in an earlier run is sampled up to the current tip", async () => {
    const c = await chain()
    const a = addr("R")
    // a 30k burst right after launch and a sparse tail: maps put it far below SOLANA_EXACT_BELOW
    c.addHistory(a, slotsFor(1500, 400000, 1000000, 0, 19).concat(slotsFor(30000, 1000000, 1000500, 0, 24)).concat(slotsFor(1500, 1000500, 1500000, 0, 25)))
    const seen = c.histories[a][0]
    const dir = freshCache()
    seedCache(dir, {
      jobs: {
        [a]: {
          baseSuccessful: 0, baseFailed: 0, topSeen: true, newestSig: seen.signature, newestSlot: seen.slot,
          lowSlotHint: 400000, pageCap: 25, abandoned: true, rangeLo: 399000, createdAt: "x",
          segments: [{ top: true, successful: 999, failed: 1, pages: 25, done: true }],
        },
      },
    })
    c.addHistory(a, slotsFor(600, 1600000, 1900000, 0, 20)) // activity since that run
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    const truth = c.ok(a).ok
    const cache = readSolanaCache(dir)
    assert.equal(got.method, "sampled")
    assert.ok(Math.abs(got.successful / truth - 1) < 0.35, `~${got.successful} vs ${truth}`)
    assert.equal(cache.entries[a].newestSlot, c.histories[a][0].slot, "counted up to the current newest signature")
    assert.ok(!cache.jobs[a], "the abandoned listing is gone")
  })

  it("S: exact mode lists from scratch an address whose saved job tops up a sampled count", async () => {
    const c = await chain()
    const a = addr("S")
    c.addHistory(a, slotsFor(2000, 100000, 900000, 0, 21))
    const old = c.histories[a][0]
    const dir = freshCache()
    seedCache(dir, {
      entries: { [a]: { successful: 1500, failed: 500, newestSig: old.signature, newestSlot: old.slot, method: "sampled", updatedAt: "x" } },
      jobs: {
        [a]: {
          baseSuccessful: 1500, baseFailed: 500, previousNewestSig: old.signature, previousNewestSlot: old.slot, topSeen: false,
          lowSlotHint: old.slot, pageCap: 30, createdAt: "x",
          segments: [{ top: true, until: old.signature, untilSlot: old.slot, successful: 0, failed: 0, pages: 0, done: false }],
        },
      },
    })
    c.addHistory(a, slotsFor(1500, 1200000, 1900000, 0, 22))
    restoreEnv()
    restoreEnv = scenarioEnv({ SOLANA_COUNT_MODE: "exact" })
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
  })
})

describe("Solana counts: interrupted runs", () => {
  it("E: a finished top-up of a sampled count stays sampled when the run fails elsewhere", async () => {
    const c = await chain()
    const e1 = addr("Ea")
    const e2 = addr("Eb")
    c.addHistory(e1, slotsFor(5000, 100000, 900000, 0, 6))
    const old = c.histories[e1]
    const dir = freshCache()
    seedCache(dir, {
      entries: { [e1]: { successful: 3300, failed: 1700, newestSig: old[0].signature, newestSlot: old[0].slot, method: "sampled", updatedAt: "x" } },
    })
    c.addHistory(e1, slotsFor(3000, 1200000, 1900000, 0, 7))
    c.addHistory(e2, slotsFor(80000, 100000, 1900000, 1, 8))
    onPlanned(() => {
      const at = Date.now()
      for (const f of c.faults) {
        f.delay = { [e2]: 150 }
        f.failWhen = { [e2]: () => Date.now() > at + 500 }
      }
    })
    assert.ok(await failsWith(() => countSolana(c, [tag(e1), tag(e2)])))
    const saved = readSolanaCache(dir).jobs[e1]
    assert.ok(saved && saved.segments.every((s: { done: boolean }) => s.done), "e1's top-up was saved, finished")
    for (const f of c.faults) {
      f.failWhen = undefined
      f.delay = undefined
    }
    const got = reportOf(await countSolana(c, [tag(e1), tag(e2)]), e1)
    assert.equal(got.method, "sampled")
    assert.equal(got.successful, 3300 + c.ok(e1, Infinity, 1200000).ok)
  })

  it("F: an auto-mode listing interrupted halfway resumes where it stopped", async () => {
    const c = await chain()
    const a = addr("F")
    c.addHistory(a, slotsFor(15000, 200000, 1900000, 0, 9))
    const dir = freshCache()
    onPlanned(() => {
      const afterCalls = (c.calls[`gsfa:${a}`] || 0) + 8
      for (const f of c.faults) f.failAfter = { [a]: afterCalls }
    })
    assert.ok(await failsWith(() => countSolana(c, [tag(a)])))
    assert.ok(readSolanaCache(dir).jobs[a], "the listing is saved")
    for (const f of c.faults) f.failAfter = undefined
    logs.clear()
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
    assert.ok(logs.has("Resuming"), "resumed, not started over")
  })

  it("G: exact mode picks up an interrupted auto listing that then passes its page cap", async () => {
    const c = await chain()
    const a = addr("G")
    c.addHistory(a, slotsFor(7000, 1000000, 1700000, 0, 10))
    restoreEnv()
    restoreEnv = scenarioEnv({ SOLANA_EXACT_BELOW: "8000" })
    freshCache()
    onPlanned(() => {
      const afterCalls = (c.calls[`gsfa:${a}`] || 0) + 4
      for (const f of c.faults) f.failAfter = { [a]: afterCalls }
    })
    assert.ok(await failsWith(() => countSolana(c, [tag(a)])))
    for (const f of c.faults) f.failAfter = undefined
    c.addHistory(a, slotsFor(6000, 1800000, 1950000, 0, 11))
    restoreEnv()
    restoreEnv = scenarioEnv({ SOLANA_EXACT_BELOW: "8000", SOLANA_COUNT_MODE: "exact" })
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
  })
})
