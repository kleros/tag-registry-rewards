import { after, before, it } from "node:test"
import { strict as assert } from "assert"
import { countEvmTxsWithHypersync } from "../../src/utils/hypersync-enrichment"
import { isBudgetExceeded, setTimeBudget, startTimeBudget } from "../../src/utils/runtime-helpers"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { freshDir } from "../support/files"
import { startMockServer } from "../support/http"

// --max-minutes also stops HyperSync's /height retries.
let logs: CapturedConsole
before(() => {
  logs = captureConsole()
  setEnv({ TX_COUNT_CACHE: "on", TX_COUNT_CACHE_DIR: freshDir("budget-") })
})
after(() => logs.restore())

it("V7: stops at a 1 s budget while /height keeps failing", async () => {
  let hits = 0
  const server = await startMockServer(() => {
    hits++
    return { status: 500, raw: "down" }
  })
  setEnv({ HYPERSYNC_URL_TEMPLATE: `${server.url}/{chainId}` })
  setTimeBudget(1 / 60)
  startTimeBudget()
  const started = Date.now()
  const outcome = await countEvmTxsWithHypersync(
    { "10": ["0x" + "a".repeat(40)] },
    { persist: true, scan: async () => ({ nextBlock: 0, transactions: [] }) }
  ).then(
    () => "finished",
    (err) => (isBudgetExceeded(err) ? "stopped at the budget" : `failed: ${(err as Error).message}`)
  )
  assert.equal(outcome, "stopped at the budget")
  assert.ok((Date.now() - started) / 1000 < 5)
  assert.ok(hits >= 1 && hits <= 2)
  await server.close()
})
