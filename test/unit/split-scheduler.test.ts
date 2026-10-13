import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { runSplittableWork, SplittableUnit } from "../../src/utils/split-scheduler"
import { sleep } from "../support/http"

// A range [next, to) scanned one block per step; split() halves what is left.
class Range implements SplittableUnit {
  busy = false
  splitRequested = false
  scanned: number[] = []
  constructor(public next: number, public to: number, readonly log: number[]) {}
  isDone(): boolean {
    return this.next >= this.to
  }
  remainingWork(): number {
    return this.to - this.next
  }
}

describe("runSplittableWork", () => {
  it("scans every position exactly once, splitting long ranges across idle workers", async () => {
    const log: number[] = []
    const units = [new Range(0, 200, log), new Range(200, 210, log)]
    let splits = 0
    await runSplittableWork(
      units,
      4,
      async (unit) => {
        await sleep(1)
        unit.log.push(unit.next)
        unit.next++
      },
      async (unit) => {
        const mid = unit.next + Math.floor((unit.to - unit.next) / 2)
        if (mid <= unit.next) return null
        const upper = new Range(mid, unit.to, unit.log)
        unit.to = mid
        splits++
        return upper
      }
    )
    assert.deepEqual(log.slice().sort((a, b) => a - b), Array.from({ length: 210 }, (_, i) => i))
    assert.ok(splits > 0, "idle workers should have split the long range")
    assert.ok(units.length > 2)
  })

  it("does nothing for no units", async () => {
    await runSplittableWork([] as Range[], 3, async () => assert.fail("no step expected"), async () => null)
  })

  it("stops on the first failure and rethrows it", async () => {
    const log: number[] = []
    const units = [new Range(0, 50, log), new Range(50, 100, log)]
    let steps = 0
    await assert.rejects(
      runSplittableWork(
        units,
        2,
        async (unit) => {
          steps++
          if (unit.next === 55) throw new Error("scan failed at 55")
          await sleep(1)
          unit.next++
        },
        async () => null
      ),
      /scan failed at 55/
    )
    assert.ok(steps < 100, "work should stop after the failure")
  })

  it("never runs a failed unit's step again on another worker", async () => {
    let attempts = 0
    await assert.rejects(
      runSplittableWork(
        [new Range(0, 10, [])],
        3,
        async () => {
          attempts++
          await sleep(1)
          throw new Error("step failed")
        },
        async () => null
      ),
      /step failed/
    )
    assert.equal(attempts, 1)
  })

  it("never splits a unit below minSplitWork", async () => {
    const log: number[] = []
    let splitCalls = 0
    await runSplittableWork(
      [new Range(0, 3, log)],
      4,
      async (unit) => {
        await sleep(1)
        unit.next++
      },
      async () => {
        splitCalls++
        return null
      },
      4
    )
    assert.equal(splitCalls, 0)
  })
})
