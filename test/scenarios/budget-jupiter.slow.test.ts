import { after, before, it } from "node:test"
import { strict as assert } from "assert"
import { enrichSolanaTagsWithRpc } from "../../src/utils/solana-rpc-enrichment"
import { isBudgetExceeded, setTimeBudget, startTimeBudget } from "../../src/utils/runtime-helpers"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { freshDir } from "../support/files"
import { MockChain } from "../support/solana"
import { poolFor, scenarioAddress, solanaTag } from "../support/solana-scenarios"

// --max-minutes also stops Jupiter's retry loop (holder pre-check).
let logs: CapturedConsole
before(() => {
  logs = captureConsole()
  setEnv({ TX_COUNT_CACHE: "on", TX_COUNT_CACHE_DIR: freshDir("budget-") })
})
after(() => logs.restore())

it("V7: stops at a 1 s budget while Jupiter keeps failing", async () => {
  const chain = await new MockChain(2000000, 1).start()
  chain.jupiterStatus = 500
  setEnv({ JUPITER_TOKENS_API_URL: chain.jupiterUrl })
  setTimeBudget(1 / 60)
  startTimeBudget()
  const started = Date.now()
  const tag = { ...solanaTag(scenarioAddress("JP")), registry: "tokens" as const }
  const outcome = await Promise.race([
    enrichSolanaTagsWithRpc([tag], { rpc: poolFor(chain), persist: true }).then(
      () => "finished",
      (err) => (isBudgetExceeded(err) ? "stopped at the budget" : `failed: ${(err as Error).message}`)
    ),
    new Promise((resolve) => setTimeout(() => resolve("still running"), 40000)),
  ])
  assert.equal(outcome, "stopped at the budget")
  assert.ok((Date.now() - started) / 1000 < 5)
  assert.ok((chain.calls.jupiter || 0) <= 2)
  await chain.stop()
})
