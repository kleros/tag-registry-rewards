import { after, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv, withEnv } from "../support/env"
import { MockDune } from "../support/dune"
import { evmAddress, makeTag, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"
import { chains } from "../../src/utils/chains"

// dune-client reads its settings when loaded: the modules are required after
// the mock is up and the environment set.
type DuneClient = typeof import("../../src/utils/dune-client")
type EvmEnrichment = typeof import("../../src/utils/evm-enrichment")
type SolanaEnrichment = typeof import("../../src/utils/solana-enrichment")

let dune: MockDune
let client: DuneClient
let evm: EvmEnrichment
let solana: SolanaEnrichment
let logs: CapturedConsole

before(async () => {
  logs = captureConsole()
  dune = await new MockDune().start()
  setEnv({
    DUNE_API_KEY: "test-dune-key",
    DUNE_BASE_URL: dune.url + "/",
    DUNE_POLL_INTERVAL_SECONDS: "0",
    DUNE_HTTP_RETRY_BASE_MS: "1",
    DUNE_HTTP_MAX_RETRIES: "4",
    EVM_TX_PROVIDER: "dune",
    SOLANA_TX_PROVIDER: "dune",
  })
  client = require("../../src/utils/dune-client")
  evm = require("../../src/utils/evm-enrichment")
  solana = require("../../src/utils/solana-enrichment")
})
after(async () => {
  logs.restore()
  await dune.stop()
})
beforeEach(() => {
  dune.sqls = []
  dune.pendingPolls = 1
  dune.failState = undefined
  dune.rateLimited = 0
  logs.clear()
})

describe("Dune client", () => {
  it("submits the SQL, polls until it completes, and returns the rows", async () => {
    dune.solanaCounts = { abc: 3 }
    dune.pendingPolls = 3
    const rows = await client.executeDuneSql("test-dune-key", "SELECT 1 FROM solana.account_activity WHERE address IN ('abc')", "t")
    assert.deepEqual(rows, [{ address: "abc", total_txns: 3 }])
    assert.ok(dune.apiKeys.every((k) => k === "test-dune-key"))
  })

  it("waits out rate limits", async () => {
    dune.rateLimited = 2
    await client.executeDuneSql("test-dune-key", "SELECT 1 FROM solana.account_activity WHERE address IN ('x')", "t")
    assert.ok(logs.has(/status=429, retry 1\/4/))
  })

  it("fails on a failed query", async () => {
    dune.failState = "QUERY_STATE_FAILED"
    await assert.rejects(client.executeDuneSql("test-dune-key", "SELECT 1", "t"), /failed with state QUERY_STATE_FAILED/)
  })

  it("needs DUNE_API_KEY", async () => {
    await withEnv({ DUNE_API_KEY: "  " }, () => assert.throws(() => client.getDuneApiKey(), /DUNE_API_KEY is required/))
  })
})

describe("EVM counts from Dune (EVM_TX_PROVIDER=dune)", () => {
  it("counts every address per chain, lowercased, and 0 for those Dune has no row for", async () => {
    const a = "0xAbC0000000000000000000000000000000000001"
    dune.evmCounts = { "1": { [a.toLowerCase()]: 12 }, "8453": { [evmAddress(2)]: 5 } }
    const res = await evm.enrichAllEvmAddresses({ "1": [a, evmAddress(3), "bogus"], "8453": [evmAddress(2)] })
    assert.deepEqual(res.byChain["1"], { [a.toLowerCase()]: { txCount: 12 }, [evmAddress(3)]: { txCount: 0 }, bogus: { txCount: 0 } })
    assert.deepEqual(res.byChain["8453"], { [evmAddress(2)]: { txCount: 5 } })
    assert.equal(res.provenance.provider, "dune")
    assert.equal(dune.sqls.length, 1, "one UNION ALL query for every chain")
    assert.match(dune.sqls[0], /FROM ethereum\.transactions\s+WHERE success = TRUE/)
    assert.match(dune.sqls[0], /FROM base\.transactions/)
  })

  it("knows the Dune schema of every rewarded EVM chain", async () => {
    const byChain: { [id: string]: string[] } = {}
    for (const chain of chains.filter((c) => c.namespaceId === "eip155")) byChain[chain.id] = [evmAddress(1)]
    await evm.enrichAllEvmAddresses(byChain)
    await assert.rejects(evm.enrichAllEvmAddresses({ "56": [evmAddress(1)] }), /No Dune schema mapping for chainId=56/)
  })

  it("rejects an unknown provider name", async () => {
    await withEnv({ EVM_TX_PROVIDER: "etherscan" }, () => assert.throws(() => evm.getEvmTxProvider(), /Invalid EVM_TX_PROVIDER="etherscan"/))
    await withEnv({ EVM_TX_PROVIDER: undefined }, () => assert.equal(evm.getEvmTxProvider(), "hypersync"))
  })
})

describe("Solana counts and holders from Dune (SOLANA_TX_PROVIDER=dune)", () => {
  it("counts transactions of every tag and holders of Tokens mints", async () => {
    const mint = solanaAddress("Mint")
    const program = solanaAddress("Prog")
    const unknownMint = solanaAddress("NoHolders")
    dune.solanaCounts = { [mint]: 70000, [program]: 3 }
    dune.solanaHolders = { [mint]: 6000 }
    const tags = [
      makeTag({ registry: "tokens", chain: SOLANA_CHAIN, tagAddress: mint }),
      makeTag({ registry: "addressTags", chain: SOLANA_CHAIN, tagAddress: program }),
      makeTag({ registry: "tokens", chain: SOLANA_CHAIN, tagAddress: unknownMint }),
    ]
    const res = await solana.enrichSolanaTagsBatch(tags)
    assert.deepEqual(res.byKey[`${SOLANA_CHAIN}:tokens:${mint}`], { txCount: 70000, totalHolders: 6000 })
    assert.deepEqual(res.byKey[`${SOLANA_CHAIN}:addressTags:${program}`], { txCount: 3, totalHolders: null })
    assert.deepEqual(res.byKey[`${SOLANA_CHAIN}:tokens:${unknownMint}`], { txCount: 0, totalHolders: 0 })
    assert.ok(logs.has(`No holder data returned by Dune for token mint ${unknownMint}`))
    assert.equal(res.provenance.provider, "dune")
  })

  it("queries 25 addresses at a time, all-time unless a lookback is set", async () => {
    const tags = Array.from({ length: 30 }, (_, i) => makeTag({ registry: "addressTags", chain: SOLANA_CHAIN, tagAddress: solanaAddress(`Addr${i}`) }))
    await solana.enrichSolanaTagsBatch(tags)
    const txQueries = dune.sqls.filter((sql) => sql.includes("solana.account_activity"))
    assert.equal(txQueries.length, 2)
    assert.ok(!txQueries[0].includes("INTERVAL"))
    dune.sqls = []
    await withEnv({ SOLANA_TX_LOOKBACK_DAYS: "30" }, () => solana.enrichSolanaTagsBatch(tags.slice(0, 1)))
    assert.match(dune.sqls[0], /block_date >= CURRENT_DATE - INTERVAL '30' day/)
  })

  it("checks its settings before a run", async () => {
    await withEnv({ SOLANA_TX_LOOKBACK_DAYS: "-2" }, () => assert.throws(() => solana.assertSolanaDuneSettings(), /Invalid SOLANA_TX_LOOKBACK_DAYS/))
    await withEnv({ SOLANA_TX_PROVIDER: "helius" }, () => assert.throws(() => solana.getSolanaTxProvider(), /Invalid SOLANA_TX_PROVIDER/))
    assert.deepEqual(await solana.enrichSolanaTagsBatch([]), { byKey: {}, provenance: { provider: "dune", definition: (await solana.enrichSolanaTagsBatch([])).provenance.definition } })
  })
})
