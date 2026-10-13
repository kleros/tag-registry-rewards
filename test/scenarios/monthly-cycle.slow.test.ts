import { after, before, describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils, Wallet } from "ethers"
import { join } from "path"
import { runCli } from "../support/cli"
import { MockDune } from "../support/dune"
import { MockEvm } from "../support/evm"
import { freshDir, listFiles, readJson } from "../support/files"
import { evmAddress, SOLANA_CHAIN, solanaAddress, unix } from "../support/fixtures"
import { MockSubgraph, subgraphItem } from "../support/subgraph"

// A whole month through the CLI, offline: `--mode all` (fetch, generate,
// removals, document) over the indexer and Dune mocks, then `send` of the
// three payout files to a mock Gnosis node, and every attempt to pay them
// again refused.
const IN = unix("2026-09-15T00:00:00Z")
const BEFORE = unix("2026-08-15T00:00:00Z")
const reg = (requester: string, at = IN) => ({ requester, requestType: "RegistrationRequested" as const, resolutionTime: at, submissionTime: at - 60 })
const clr = (requester: string, at = IN) => ({ requester, requestType: "ClearingRequested" as const, resolutionTime: at, submissionTime: at - 60 })

let subgraph: MockSubgraph
let dune: MockDune
let evm: MockEvm
const cwd = freshDir("month-")
const wallet = Wallet.createRandom()
let env: { [k: string]: string }

before(async () => {
  subgraph = await new MockSubgraph().start()
  dune = await new MockDune().start()
  evm = await new MockEvm({ startTime: unix("2026-10-03T00:00:00Z") }).start()
  evm.setTokenBalance(wallet.address, utils.parseEther("1000000"))
  evm.setNativeBalance(wallet.address, utils.parseEther("5"))
  const mint = solanaAddress("Mint")
  subgraph.add(
    subgraphItem("tokens", { requests: [reg(evmAddress(0xa1))], key0: `eip155:100:${evmAddress(0x7001)}` }),
    subgraphItem("tokens", { requests: [reg(evmAddress(0xa2))], key0: `solana:${SOLANA_CHAIN}:${mint}` }),
    subgraphItem("domains", { requests: [reg(evmAddress(0xa1))], key0: `eip155:1:${evmAddress(0xd001)}` }),
    subgraphItem("domains", { requests: [reg(evmAddress(0xa3))], key0: `eip155:8453:${evmAddress(0xd002)}` }),
    subgraphItem("tokens", { status: "Absent", requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xb1))] }),
    subgraphItem("atq", { requests: [reg(evmAddress(0xc1))] }),
    subgraphItem("atq", { status: "Absent", requests: [reg(evmAddress(1), BEFORE), clr(evmAddress(0xc2))] })
  )
  dune.evmCounts = { "100": { [evmAddress(0x7001)]: 900 }, "1": { [evmAddress(0xd001)]: 300 }, "8453": { [evmAddress(0xd002)]: 100 } }
  dune.solanaCounts = { [mint]: 4000000 }
  dune.solanaHolders = { [mint]: 25000 }
  env = {
    XDAI_GTCR_SUBGRAPH_URL: subgraph.url,
    EVM_TX_PROVIDER: "dune",
    SOLANA_TX_PROVIDER: "dune",
    DUNE_API_KEY: "k",
    DUNE_BASE_URL: dune.url,
    DUNE_POLL_INTERVAL_SECONDS: "0",
    TX_RPC_URL: evm.url,
    PNK: evm.token,
    WALLET_PRIVATE_KEY: wallet.privateKey,
    SEND_POLL_MS: "5",
  }
})
after(async () => {
  await subgraph.stop()
  await dune.stop()
  await evm.stop()
})

describe("a month, end to end", () => {
  let files: { submissions: string; removals: string; atq: string }

  it("computes and documents the period with --mode all, sending nothing", async () => {
    const res = await runCli(["--mode", "all", "--period", "2026-09"], { cwd, env, timeoutMs: 120000 })
    assert.equal(res.code, 0, res.output)
    const generate = readJson(join(cwd, "files", "latest_generate_manifest.json"))
    const removals = readJson(join(cwd, "files", "latest_removals_manifest.json"))
    files = { submissions: generate.transactionsFile, removals: removals.transactionsFile, atq: removals.atqTransactionsFile }
    assert.equal(generate.periodStart, "2026-09-01T00:00:00.000Z")
    for (const file of Object.values(files)) assert.ok(res.stdout.includes(`yarn start --mode send --rewards ${file}`))
    assert.equal(evm.transfersFrom(wallet.address).length, 0, "all never sends")
    const snapshot = readJson(join(cwd, "files", "curate-rewards-2026-09.json"))
    assert.deepEqual(snapshot.entryCounts, { submissions: 4, removals: 1, atq: 2, total: 7 })
    assert.equal(readJson(join(cwd, "files", "curate-rewards-index.json"))[0].period, "2026-09")
  })

  it("pays each of the three files once", async () => {
    let expected = BigNumber.from(0)
    for (const file of [files.submissions, files.removals, files.atq]) {
      const res = await runCli(["--mode", "send", "--rewards", file], { cwd, env })
      assert.equal(res.code, 0, res.output)
      for (const t of readJson(join(cwd, "files", file))) expected = expected.add(BigNumber.from(t.amount))
    }
    const paid = evm.transfersFrom(wallet.address)
    const total = paid.reduce((acc, t) => acc.add(t.amount), BigNumber.from(0))
    assert.equal(total.toString(), expected.toString())
    assert.ok(paid.every((t) => t.status === 1))
    assert.deepEqual(
      listFiles(join(cwd, "disbursements")).map((name) => name.replace(/-[0-9a-f]{12}\.json$/, "")),
      ["2026-09-atq", "2026-09-removals", "2026-09-submissions"]
    )
  })

  it("refuses every one of them afterwards, and a regenerated submissions file too", async () => {
    const before = evm.transfersFrom(wallet.address).length
    for (const file of [files.submissions, files.removals, files.atq]) {
      const res = await runCli(["--mode", "send", "--rewards", file], { cwd, env })
      assert.equal(res.code, 1)
      assert.match(res.stderr, /Refusing to send: this payout was already disbursed/)
    }
    // regenerate (e.g. after adding an exclusion) and try to pay the period again
    require("fs").writeFileSync(join(cwd, "exclusions.json"), JSON.stringify([{ tagAddress: evmAddress(0xd002), reason: "test" }]))
    assert.equal((await runCli(["--mode", "generate"], { cwd, env })).code, 0)
    const regenerated = readJson(join(cwd, "files", "latest_generate_manifest.json")).transactionsFile
    assert.notEqual(regenerated, files.submissions)
    const res = await runCli(["--mode", "send", "--rewards", regenerated], { cwd, env })
    assert.equal(res.code, 1)
    assert.match(res.stderr, /would pay that period twice/)
    assert.equal(evm.transfersFrom(wallet.address).length, before, "nothing more was sent")
    const list = await runCli(["--mode", "disbursements"], { cwd, env })
    assert.equal(list.stdout.trim().split("\n").length, 3)
  })
})
