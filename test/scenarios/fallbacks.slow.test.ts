import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { checkHolders } from "../../src/utils/solana-rpc-enrichment"
import { countEvmTxsWithHypersync, getHypersyncHeight } from "../../src/utils/hypersync-enrichment"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv, withEnv } from "../support/env"
import { startMockServer } from "../support/http"
import { solanaAddress } from "../support/fixtures"
import { MockChain, newChain } from "../support/solana"
import { poolFor } from "../support/solana-scenarios"

// Fallbacks that wait between retries (seconds each), hence the slow tier.
let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())

describe("Jupiter down", () => {
  let chain: MockChain
  let restore: () => void
  beforeEach(async () => {
    chain = await newChain(1)
    restore = setEnv({ JUPITER_TOKENS_API_URL: chain.jupiterUrl })
  })
  afterEach(async () => {
    restore()
    await chain.stop()
  })

  it("checks every mint on-chain after four failed Jupiter attempts", async () => {
    const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    chain.accounts[TOKEN] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }
    chain.accounts["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }
    const mint = solanaAddress("Jdown")
    chain.accounts[mint] = { owner: TOKEN }
    for (let i = 0; i < 4; i++) chain.tokenAccounts.push({ mint, owner: Buffer.alloc(32, i + 1) })
    chain.jupiterStatus = 503
    const out = await checkHolders(poolFor(chain), [mint], 5000)
    assert.deepEqual(out[mint], { holders: 4, source: "onchain", createdAt: undefined })
    assert.equal(chain.calls.jupiter, 4)
    assert.ok(logs.has("Jupiter lookup failed"))
  })
})

describe("HyperSync retries", () => {
  it("stops after three requests that do not move forward", async () => {
    let requests = 0
    await assert.rejects(
      countEvmTxsWithHypersync(
        { "10": ["0x" + "a".repeat(40)] },
        {
          persist: false,
          getHeight: async () => 5000,
          scan: async (_chainId, query) => {
            requests++
            return { nextBlock: (query as { fromBlock: number }).fromBlock, transactions: [] }
          },
        }
      ),
      /no progress at block 0 after 3 requests/
    )
    assert.equal(requests, 3)
  })

  it("retries /height until the server answers", async () => {
    let hits = 0
    const server = await startMockServer(() => (++hits === 1 ? { status: 502, raw: "bad gateway" } : { body: { height: 777 } }))
    await withEnv({ HYPERSYNC_URL_TEMPLATE: `${server.url}/{chainId}` }, async () => {
      assert.equal(await getHypersyncHeight("10"), 777)
    })
    assert.equal(hits, 2)
    await server.close()
  })
})
