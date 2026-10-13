import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { checkDeadline, isBudgetExceeded, setTimeBudget, sleep, startTimeBudget } from "../../src/utils/runtime-helpers"

// Module state: the budget can only be started once per process, so this file
// holds the whole life cycle in order.
describe("--max-minutes time budget", () => {
  it("never stops a run without a budget", () => {
    startTimeBudget()
    checkDeadline()
  })

  it("starts with the counting, not when the budget is set", async () => {
    setTimeBudget(0.0005) // 30 ms
    await sleep(60)
    checkDeadline() // set long ago, but the clock has not started
    startTimeBudget()
    checkDeadline()
    await sleep(60)
    assert.throws(() => checkDeadline(), (err: unknown) => isBudgetExceeded(err))
  })

  it("keeps the first deadline when counting starts again", async () => {
    startTimeBudget()
    assert.throws(() => checkDeadline(), (err: unknown) => isBudgetExceeded(err))
  })
})
