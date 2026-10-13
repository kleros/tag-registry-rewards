import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { findHistoryStart } from "../../src/utils/solana-rpc-enrichment"
import { captureConsole, CapturedConsole } from "../support/console"
import { MockChain, newChain, slotsFor } from "../support/solana"
import {
  countSolana,
  failsWith,
  freshCache,
  poolFor,
  readSolanaCache,
  reportOf,
  scenarioAddress as addr,
  scenarioEnv,
  seedCache,
  solanaTag as tag,
} from "../support/solana-scenarios"

// Interrupted Solana counts resume with their saved work (samples, maps,
// windows) and end with the same answer an uninterrupted run gives
// (scenarios U and V of the PR #27 audits).

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
const callsOf = (c: MockChain) => (c.calls.getSignaturesForAddress || 0) + (c.calls.getBlock || 0)
const gsfa = (c: MockChain, a: string) => c.calls[`gsfa:${a}`] || 0
const failAfter = (c: MockChain, a: string, calls: number | undefined) => {
  for (const f of c.faults) f.failAfter = calls === undefined ? undefined : { [a]: calls }
}
const mapPoints = (sample: { map?: { density: unknown[] } } | undefined): number =>
  sample && sample.map ? sample.map.density.filter((d) => typeof d === "number").length : 0

describe("saved samples", () => {
  it("U1: a sample interrupted halfway resumes with its map and windows: same estimate, fewer calls", async () => {
    const c = await chain()
    const a = addr("U")
    c.addHistory(a, slotsFor(60000, 300000, 1900000, 1, 31))
    freshCache()
    const before0 = callsOf(c)
    const ref = reportOf(await countSolana(c, [tag(a)]), a)
    const refCalls = callsOf(c) - before0
    const dir = freshCache()
    logs.onLine("SOLANA_COUNT_MODE=auto:", () => failAfter(c, a, gsfa(c, a) + 20))
    assert.ok(await failsWith(() => countSolana(c, [tag(a)])))
    const saved = (readSolanaCache(dir).samples || {})[a]
    const done = saved && saved.windows ? saved.windows.filter((w: { total?: number }) => w.total !== undefined).length : -1
    assert.ok(done > 0 && done < saved.windows.length, `saved ${done} of the windows`)
    failAfter(c, a, undefined)
    c.addHistory(a, slotsFor(500, 1950000, 1990000, 0, 32)) // activity since
    logs.clear()
    const start = callsOf(c)
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "sampled")
    assert.equal(got.successful, ref.successful + c.ok(a, Infinity, 1950000).ok, "the same windows, topped up")
    assert.ok(callsOf(c) - start < refCalls)
    assert.ok(logs.has("Resuming 1 interrupted sample"))
    const cache = readSolanaCache(dir)
    assert.deepEqual(cache.samples, {})
    assert.equal(cache.entries[a].newestSlot, c.histories[a][0].slot)
  })

  it("U2: a saved sample whose base is no longer the cached count is dropped", async () => {
    const c = await chain()
    const a = addr("Ua")
    c.addHistory(a, slotsFor(3000, 100000, 900000, 0, 33))
    const old = c.histories[a][0]
    const base = c.ok(a)
    const dir = freshCache()
    const entry = { successful: base.ok, failed: base.total - base.ok, newestSig: old.signature, newestSlot: old.slot, method: "exact", updatedAt: "x" }
    seedCache(dir, {
      entries: { [a]: entry },
      samples: {
        [a]: {
          lo: 950000, hi: 960000, base: { ...entry, successful: 1 }, newest: { signature: "zz", slot: 959999 }, createdAt: "x",
          map: { lo: 950000, hi: 960000, cell: 5000, density: [1, 1], size: 10000, calls: 0 },
          windows: [{ a0: 950000, a1: 960000, w: 10, ranges: [[950000, 950010]], total: 999999, ok: 999999 }],
        },
      },
    })
    c.addHistory(a, slotsFor(1000, 1200000, 1900000, 0, 34))
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
    assert.ok(!readSolanaCache(dir).samples[a])
  })

  it("U3: exact mode lists an address instead of resuming its saved sample", async () => {
    const c = await chain()
    const a = addr("Ub")
    c.addHistory(a, slotsFor(4000, 100000, 1900000, 0, 35))
    const dir = freshCache()
    seedCache(dir, {
      samples: {
        [a]: {
          lo: 100000, hi: 1900000, newest: { signature: c.histories[a][0].signature, slot: c.histories[a][0].slot }, createdAt: "x",
          map: { lo: 100000, hi: 1900000, cell: 900000, density: [1, 1], size: 1, calls: 0 },
          windows: [{ a0: 100000, a1: 1900000, w: 10, ranges: [[100000, 100010]], total: 999999, ok: 999999 }],
        },
      },
    })
    restoreEnv()
    restoreEnv = scenarioEnv({ SOLANA_COUNT_MODE: "exact" })
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
    assert.ok(!readSolanaCache(dir).samples[a])
  })

  it("U4: a listing past its page cap is saved as a sample before it is sampled", async () => {
    const c = await chain()
    const a = addr("Uc")
    // a 30k burst inside 500 slots between map points: sized small, listed, capped
    c.addHistory(a, slotsFor(1500, 400000, 1000000, 0, 36).concat(slotsFor(30000, 1000000, 1000500, 0, 37)).concat(slotsFor(1500, 1000500, 1500000, 0, 38)))
    freshCache()
    const ref = reportOf(await countSolana(c, [tag(a)]), a)
    assert.ok(logs.has("passed their page cap"), "the reference run hit the cap")
    logs.clear()
    const dir = freshCache()
    logs.onLine("passed their page cap", () => failAfter(c, a, gsfa(c, a) + 15))
    assert.ok(await failsWith(() => countSolana(c, [tag(a)])))
    const cache = readSolanaCache(dir)
    assert.ok(cache.samples && cache.samples[a] && !cache.jobs[a], "the sample is saved, the listing gone")
    failAfter(c, a, undefined)
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "sampled")
    assert.equal(got.successful, ref.successful)
  })
})

describe("sample windows and maps (external review of ca1b609)", () => {
  for (const urls of [1, 2]) {
    it(`V1: short pages inside a sample window are not taken for the end of the history (${urls} URL)`, async () => {
      const c = await chain(urls)
      const a = addr(`V${urls}`)
      c.addHistory(a, slotsFor(3000, 500000, 1500000, 0, 41))
      for (const f of c.faults) f.truncate = { [a]: 600 }
      // one stratum with a window wider than the range: the sample is a plain count
      restoreEnv()
      restoreEnv = scenarioEnv({ SOLANA_EXACT_BELOW: "1000", SOLANA_SAMPLE_STRATA: "1", SOLANA_SAMPLE_WINDOW: "1000000000" })
      freshCache()
      const sampled = reportOf(await countSolana(c, [tag(a)]), a)
      restoreEnv()
      restoreEnv = scenarioEnv({ SOLANA_COUNT_MODE: "exact" })
      freshCache()
      const exact = reportOf(await countSolana(c, [tag(a)]), a)
      assert.equal(sampled.successful, c.ok(a).ok)
      assert.equal(exact.successful, c.ok(a).ok)
    })
  }

  it("V2: exact mode after an interrupted top-up of a sampled count lists everything", async () => {
    const c = await chain()
    const a = addr("W")
    c.addHistory(a, slotsFor(2000, 100000, 900000, 0, 42))
    const old = c.histories[a][0]
    const dir = freshCache()
    seedCache(dir, {
      entries: { [a]: { successful: 1500, failed: 500, newestSig: old.signature, newestSlot: old.slot, method: "sampled", updatedAt: "x" } },
      jobs: {
        [a]: {
          baseSuccessful: 1500, baseFailed: 500, previousNewestSig: old.signature, previousNewestSlot: old.slot, topSeen: false,
          lowSlotHint: old.slot, pageCap: 30, rangeLo: old.slot + 1, sampledBase: true, createdAt: "x",
          segments: [{ top: true, until: old.signature, untilSlot: old.slot, successful: 0, failed: 0, pages: 0, done: false }],
        },
      },
    })
    c.addHistory(a, slotsFor(1500, 1200000, 1900000, 0, 43))
    restoreEnv()
    restoreEnv = scenarioEnv({ SOLANA_COUNT_MODE: "exact" })
    const first = reportOf(await countSolana(c, [tag(a)]), a)
    const second = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(first.method, "exact")
    assert.equal(first.successful, c.ok(a).ok)
    assert.equal(second.successful, c.ok(a).ok)
  })

  it("V3: an interrupted full map keeps its points, three runs in a row", async () => {
    const c = await chain()
    const a = addr("X")
    c.addHistory(a, slotsFor(60000, 300000, 1900000, 1, 44))
    freshCache()
    const ref = reportOf(await countSolana(c, [tag(a)]), a)
    const dir = freshCache()
    const saved: number[] = []
    for (let run = 0; run < 3; run++) {
      const stopAt = gsfa(c, a) + 110
      failAfter(c, a, stopAt)
      const threw = await failsWith(() => countSolana(c, [tag(a)]))
      let cache: { samples?: { [k: string]: { map?: { density: unknown[] } } } } = {}
      try {
        cache = readSolanaCache(dir)
      } catch {
        // nothing saved yet
      }
      saved.push(threw ? mapPoints((cache.samples || {})[a]) : 999)
      c.calls[`gsfa:${a}`] = stopAt // the mock counts the refused call too
    }
    failAfter(c, a, undefined)
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.ok(saved[0] > 0 && saved[1] > saved[0] && saved[2] >= saved[1], `points saved after each run: ${saved.join(", ")}`)
    assert.equal(got.successful, ref.successful)
  })

  it("V5: a range interrupted while it was sized is listed when the sizing finds it small", async () => {
    const c = await chain()
    const a = addr("Y")
    c.addHistory(a, slotsFor(12000, 300000, 1900000, 0, 45))
    const dir = freshCache()
    failAfter(c, a, 60)
    assert.ok(await failsWith(() => countSolana(c, [tag(a)])))
    const plan = (readSolanaCache(dir).samples || {})[a]
    assert.ok(plan && plan.sizing === true && mapPoints(plan) > 20, "a sizing plan with its map points is saved")
    failAfter(c, a, undefined)
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.equal(got.method, "exact")
    assert.equal(got.successful, c.ok(a).ok)
    const cache = readSolanaCache(dir)
    assert.deepEqual(cache.samples, {})
    assert.ok(!cache.jobs[a])
  })

  it("V6: interrupted inside the quick map, three times: the plan and its points carry over", async () => {
    const c = await chain()
    const a = addr("Z")
    c.addHistory(a, slotsFor(60000, 300000, 1900000, 1, 46))
    freshCache()
    const ref = reportOf(await countSolana(c, [tag(a)]), a)
    const before0 = gsfa(c, a)
    await findHistoryStart(poolFor(c), a, c.tip)
    const startCalls = gsfa(c, a) - before0
    const dir = freshCache()
    const points: number[] = []
    for (let run = 0; run < 3; run++) {
      const stopAt = gsfa(c, a) + startCalls + 3 + 4 // newest page, start search, 4 quick-map points
      failAfter(c, a, stopAt)
      const threw = await failsWith(() => countSolana(c, [tag(a)]))
      let plan
      try {
        plan = (readSolanaCache(dir).samples || {})[a]
      } catch {
        plan = undefined
      }
      points.push(!threw ? 999 : plan ? mapPoints(plan) : -1)
      c.calls[`gsfa:${a}`] = stopAt
    }
    failAfter(c, a, undefined)
    const got = reportOf(await countSolana(c, [tag(a)]), a)
    assert.ok(points[0] >= 0 && points[1] > points[0] && points[2] >= points[1], `points after each run: ${points.join(", ")}`)
    assert.equal(got.successful, ref.successful)
  })
})
