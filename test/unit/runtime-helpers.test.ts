import { describe, it } from "node:test"
import { strict as assert } from "assert"
import {
  BudgetExceededError,
  chunk,
  envInt,
  errorMessage,
  forEachConcurrent,
  isBudgetExceeded,
  settleAll,
  sleep,
} from "../../src/utils/runtime-helpers"
import { withEnv } from "../support/env"

describe("envInt", () => {
  it("returns the fallback when the setting is unset or blank", async () => {
    await withEnv({ TEST_INT: undefined }, () => assert.equal(envInt("TEST_INT", 7), 7))
    await withEnv({ TEST_INT: "  " }, () => assert.equal(envInt("TEST_INT", 7), 7))
  })

  it("parses non-negative integers, trimmed", async () => {
    await withEnv({ TEST_INT: " 42 " }, () => assert.equal(envInt("TEST_INT", 7), 42))
    await withEnv({ TEST_INT: "0" }, () => assert.equal(envInt("TEST_INT", 7), 0))
  })

  it("throws on a typo instead of silently using the default", async () => {
    for (const bad of ["-1", "1.5", "abc", "1e3x"]) {
      await withEnv({ TEST_INT: bad }, () =>
        assert.throws(() => envInt("TEST_INT", 7), new RegExp(`Invalid TEST_INT="${bad.replace(".", "\\.")}"`))
      )
    }
  })
})

describe("chunk", () => {
  it("splits into slices of at most `size`", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
    assert.deepEqual(chunk([1, 2], 5), [[1, 2]])
    assert.deepEqual(chunk([], 3), [])
  })
})

describe("errorMessage", () => {
  it("reads an Error's message, or stringifies anything else", () => {
    assert.equal(errorMessage(new Error("boom")), "boom")
    assert.equal(errorMessage("plain"), "plain")
    assert.equal(errorMessage(42), "42")
  })
})

describe("BudgetExceededError", () => {
  it("is recognised by isBudgetExceeded, other errors are not", () => {
    const err = new BudgetExceededError()
    assert.equal(err.name, "BudgetExceededError")
    assert.equal(err.message, "time budget reached")
    assert.equal(isBudgetExceeded(err), true)
    assert.equal(isBudgetExceeded(new Error("time budget reached")), false)
    assert.equal(isBudgetExceeded(undefined), false)
  })
})

describe("settleAll", () => {
  it("returns every value in order when all succeed", async () => {
    assert.deepEqual(await settleAll([Promise.resolve(1), sleep(5).then(() => 2), Promise.resolve(3)]), [1, 2, 3])
  })

  it("waits for the work still running before it throws", async () => {
    let slowEnded = 0
    let rejectedAt = 0
    await settleAll([
      Promise.reject(new Error("fast failure")),
      sleep(80).then(() => {
        slowEnded = Date.now()
      }),
    ]).catch(() => {
      rejectedAt = Date.now()
    })
    assert.ok(slowEnded > 0 && rejectedAt >= slowEnded, "settleAll rejected before the slow promise ended")
  })

  it("prefers a real error to a time-budget stop, and reports each failure", async () => {
    const heard: unknown[] = []
    await assert.rejects(
      settleAll(
        [Promise.reject(new BudgetExceededError()), sleep(10).then(() => Promise.reject(new Error("real failure")))],
        (err) => heard.push(err)
      ),
      /real failure/
    )
    assert.equal(heard.length, 2)
  })

  it("throws the budget stop when it is the only failure", async () => {
    await assert.rejects(settleAll([Promise.reject(new BudgetExceededError())]), (err) => isBudgetExceeded(err))
  })
})

describe("forEachConcurrent", () => {
  it("runs every item with at most `concurrency` in flight", async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    await forEachConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(2)
      seen.push(i)
      inFlight--
    })
    assert.equal(peak, 3)
    assert.deepEqual(seen.slice().sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
  })

  it("starts no new task once one has failed", async () => {
    let started = 0
    await assert.rejects(
      forEachConcurrent(Array.from({ length: 30 }, (_, i) => i), 3, async (i) => {
        started++
        if (i === 1) throw new Error("boom") // fails while the other two still run
        await sleep(20)
      }),
      /boom/
    )
    await sleep(60)
    assert.equal(started, 3, `${started} of 30 tasks started`)
  })

  it("lets running tasks finish and reports a real error before a budget stop", async () => {
    let slowEnded = 0
    let rejectedAt = 0
    let thrown = ""
    await forEachConcurrent([0, 1, 2], 3, async (i) => {
      if (i === 0) throw new BudgetExceededError()
      if (i === 1) {
        await sleep(30)
        throw new Error("real failure")
      }
      await sleep(60)
      slowEnded = Date.now()
    }).catch((err) => {
      rejectedAt = Date.now()
      thrown = (err as Error).message
    })
    assert.equal(thrown, "real failure")
    assert.ok(slowEnded > 0 && rejectedAt >= slowEnded)
  })

  it("handles an empty list and a concurrency above the item count", async () => {
    await forEachConcurrent([], 4, async () => assert.fail("no task expected"))
    const done: number[] = []
    await forEachConcurrent([1, 2], 10, async (i) => {
      done.push(i)
    })
    assert.deepEqual(done.sort(), [1, 2])
  })
})
