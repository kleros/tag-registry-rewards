import { after, before, it } from "node:test"
import { strict as assert } from "assert"
import { enrichSolanaTagsWithRpc } from "../../src/utils/solana-rpc-enrichment"
import { isBudgetExceeded, setTimeBudget, startTimeBudget } from "../../src/utils/runtime-helpers"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { freshDir } from "../support/files"
import { MockChain } from "../support/solana"
import { poolFor, scenarioAddress, solanaTag } from "../support/solana-scenarios"

// --max-minutes must stop the Solana lane promptly even when every call is
// rate limited (retries and 429 waits check the clock too). One budget per
// process, hence one file.
let logs: CapturedConsole
before(() => {
  logs = captureConsole()
  setEnv({ TX_COUNT_CACHE: "on", TX_COUNT_CACHE_DIR: freshDir("budget-") })
})
after(() => logs.restore())

it("V4: stops at a 1 s budget while every call answers 429", async () => {
  const chain = await new MockChain(2000000, 2).start()
  for (const f of chain.faults) f.rateLimitAll = true
  setTimeBudget(1 / 60)
  startTimeBudget()
  const started = Date.now()
  const outcome = await Promise.race([
    enrichSolanaTagsWithRpc([solanaTag(scenarioAddress("DL"))], { rpc: poolFor(chain), persist: true }).then(
      () => "finished",
      (err) => (isBudgetExceeded(err) ? "stopped at the budget" : `failed: ${(err as Error).message}`)
    ),
    new Promise((resolve) => setTimeout(() => resolve("still running"), 30000)),
  ])
  const seconds = (Date.now() - started) / 1000
  assert.equal(outcome, "stopped at the budget")
  assert.ok(seconds < 5, `took ${seconds.toFixed(1)} s`)
  await chain.stop()
})
