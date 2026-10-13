import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils } from "ethers"
import { copyFileSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { listDisbursementsRoutine, readTransactionsFile, resolveSource } from "../../src/send-routine"
import { MockEvm } from "../support/evm"
import { setEnv } from "../support/env"
import { FIXTURES, listFiles, readJson, writeJson } from "../support/files"
import { evmAddress, unix } from "../support/fixtures"
import {
  AUGUST,
  evm,
  installSendHarness,
  ledger,
  lines,
  log,
  output,
  paid,
  PAYOUT,
  PNK,
  send,
  SEPTEMBER,
  startChain,
  wallet,
  work,
  writePayout,
} from "../support/send-harness"

// `send` against a mock Gnosis node: paying, and refusing to pay twice.
// Interrupted runs and node answers: send-recovery.test.ts.
installSendHarness()

describe("send: paying a file", () => {
  it("pays every transfer once, waits for each receipt, and records it", async () => {
    writePayout("1790000000001.json", PAYOUT)
    const result = await send("1790000000001.json")
    assert.equal(result.sent, 3)
    assert.deepEqual(
      paid().map((t) => [t.to, t.amount, t.status]),
      PAYOUT.map((e) => [utils.getAddress(e.recipient), BigNumber.from(e.amount).toString(), 1])
    )
    for (const e of PAYOUT) assert.equal(evm.tokenBalance(e.recipient).toString(), BigNumber.from(e.amount).toString())
    const [record] = ledger()
    assert.equal(record.status, "completed")
    assert.equal(record.kind, "submissions")
    assert.equal(record.periodStart, SEPTEMBER.periodStart)
    assert.equal(record.from, wallet.address)
    assert.equal(record.total, PNK("1741.5").toString())
    assert.ok(record.transfers.every((t) => t.status === "confirmed" && t.txHash && t.blockNumber && !t.rawTx))
    assert.deepEqual(listFiles(join(work, "disbursements")), [`2026-09-submissions-${record.id.slice(0, 12)}.json`])
    assert.ok(output().includes("Done: 3 transfers confirmed"))
  })

  it("signs EIP-1559 PNK transfers on the configured chain, fees and nonces", async () => {
    evm.nonces.set(wallet.address.toLowerCase(), 41) // the wallet's earlier transactions
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    const mined = Array.from(evm.mined.values()).filter((tx) => tx.from === wallet.address.toLowerCase())
    assert.deepEqual(mined.map((tx) => tx.nonce), [41, 42, 43])
    for (const tx of mined) {
      assert.equal(tx.type, 2)
      assert.equal(tx.chainId, 100)
      assert.equal(utils.getAddress(tx.to), evm.token)
      assert.equal(tx.maxFeePerGas.toString(), utils.parseUnits("2", "gwei").toString())
      assert.equal(String(tx.maxPriorityFeePerGas), utils.parseUnits("1", "gwei").toString())
      assert.equal(String(tx.gasLimit), "100000")
    }
  })

  it("reads the amounts of old files and plain wei strings alike, and leaves zero amounts out", async () => {
    writeJson(join(work, "files", "manual.json"), [
      { amount: { type: "BigNumber", hex: "0x1b1ae4d6e2ef500000" }, recipient: evmAddress(0x201) }, // 500 PNK
      { amount: "7000000000000000000", recipient: evmAddress(0x202).toUpperCase().replace("0X", "0x") },
      { amount: "0", recipient: evmAddress(0x203) },
    ])
    await send("manual.json", { period: "2026-09" })
    assert.deepEqual(paid().map((t) => t.amount), [PNK(500).toString(), PNK(7).toString()])
    assert.ok(output().includes("(1 zero-amount entry left out)"))
    assert.equal(ledger()[0].kind, "unknown")
  })
})

describe("send: refusing to pay twice", () => {
  it("refuses a file that was already disbursed, sending nothing", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    await assert.rejects(send("1790000000001.json"), /Refusing to send: this payout was already disbursed\. submissions for 2026-09 \(1790000000001\.json\): disbursed on \d{4}-\d\d-\d\d, 3\/3 transfers, 1741\.5 PNK, in disbursements\/2026-09-submissions-[0-9a-f]{12}\.json/)
    assert.equal(paid().length, 3)
  })

  it("finds a file's manifest however its name is spelled, so a regenerated file for a paid month is refused", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    // regenerated after an exclusion: every amount changes (rewards are pool-based)
    writePayout("1790000000002.json", PAYOUT.map((e) => ({ recipient: e.recipient, amount: BigNumber.from(e.amount).add(1) })))
    const spellings = ["./1790000000002.json", "files/1790000000002.json", join(work, "files", "1790000000002.json")]
    if (existsSync(join(work, "files", "1790000000002.JSON"))) spellings.push("1790000000002.JSON") // case-insensitive file system
    for (const spelling of spellings) await assert.rejects(send(spelling), /would pay that period twice/, spelling)
    assert.equal(paid().length, 3)
  })

  it("refuses a new payout whose period no manifest gives, until --period gives it", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    // the regenerated file again, renamed: no manifest names it
    writeJson(join(work, "files", "september-final.json"), PAYOUT.map((e) => ({ recipient: e.recipient, amount: BigNumber.from(e.amount).add(1).toString() })))
    await assert.rejects(send("september-final.json"), /period of september-final\.json is unknown.*--period YYYY-MM.*Nothing was sent/s)
    await assert.rejects(send("september-final.json", { dryRun: true }), /period of september-final\.json is unknown/)
    await assert.rejects(send("september-final.json", { period: "2026-09" }), /would pay that period twice/)
    assert.equal(paid().length, 3)
    await send("september-final.json", { period: "2026-10" }) // the operator says it is October's
    assert.equal(paid().length, 6)
    assert.equal(ledger()[1].periodStart, "2026-10-01T00:00:00.000Z")
  })

  it("refuses a --period that contradicts the file's manifest, or is not a month", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json", { period: "2026-10" }), /--period 2026-10 contradicts 1790000000001_generate_manifest\.json, which gives 2026-09/)
    await assert.rejects(send("1790000000001.json", { period: "2026-9" }), /Invalid --period "2026-9"\. Expected YYYY-MM/)
    await send("1790000000001.json", { period: "2026-09" })
    assert.equal(paid().length, 3)
  })

  it("recognises the same payout under another file name or formatting", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    writeJson(join(work, "files", "copy.json"), PAYOUT.slice().reverse().map((e) => ({ recipient: e.recipient.toUpperCase().replace("0X", "0x"), amount: BigNumber.from(e.amount).toString() })))
    await assert.rejects(send("copy.json"), /already disbursed/)
    assert.equal(paid().length, 3)
  })

  it("refuses a second file for a period and kind already paid, unless told it is deliberate", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    const corrected = [PAYOUT[0], { recipient: PAYOUT[1].recipient, amount: PNK(1300) }]
    writePayout("1790000000002.json", corrected)
    await assert.rejects(send("1790000000002.json"), /would pay that period twice.*--allow-repeat-period/s)
    assert.equal(paid().length, 3)
    // allowed as an extra payout, its transfer identical to one already paid is still caught
    await assert.rejects(send("1790000000002.json", { allowRepeatPeriod: true }), /1 of the 2 transfers to send repeat transfers.*paid by submissions for 2026-09 \(1790000000001\.json\)/s)
    await send("1790000000002.json", { allowRepeatPeriod: true, skipPaidOnChain: true })
    assert.equal(paid().length, 4, "only the changed transfer was sent")
  })

  it("lets another kind or another period of payout through", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    writePayout("1790000000003_removals_transactions.json", [{ recipient: evmAddress(0x301), amount: PNK(500) }], { kind: "removals" })
    writePayout("1790000000004.json", [{ recipient: evmAddress(0x302), amount: PNK(9) }], { period: AUGUST })
    await send("1790000000003_removals_transactions.json")
    await send("1790000000004.json")
    assert.equal(paid().length, 5)
    assert.deepEqual(ledger().map((r) => r.kind).sort(), ["removals", "submissions", "submissions"])
  })

  it("refuses a payout whose transfers are already on-chain; --skip-paid-on-chain records it as paid", async () => {
    // a file paid before the ledger existed, or from another machine
    for (const e of PAYOUT) evm.addPastTransfer(wallet.address, e.recipient, e.amount)
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(
      send("1790000000001.json"),
      /every remaining transfer of this payout is already paid since 2026-10-01.*--skip-paid-on-chain to record it as paid.*Nothing was sent/s
    )
    assert.equal(paid().length, 0)
    assert.deepEqual(ledger(), [], "nothing recorded: the operator says whether they are this file's")
    await send("1790000000001.json", { skipPaidOnChain: true })
    assert.equal(paid().length, 0)
    const [record] = ledger()
    assert.equal(record.status, "completed")
    assert.ok(record.transfers.every((t) => t.foundOnChain && t.txHash))
    await assert.rejects(send("1790000000001.json"), /already disbursed/, "the ledger now knows")
  })

  it("leaves a coincidence to the operator: an unrelated identical transfer is never taken for this payout", async () => {
    const X = evmAddress(0x777)
    evm.addPastTransfer(wallet.address, X, PNK(500)) // e.g. the month's ATQ reward, paid from another machine
    writePayout("1790000000040_removals_transactions.json", [{ recipient: X, amount: PNK(500) }], { kind: "removals" })
    await assert.rejects(send("1790000000040_removals_transactions.json"), /every remaining transfer.*--skip-onchain-check to send it/s)
    assert.deepEqual(ledger(), [])
    await send("1790000000040_removals_transactions.json", { skipOnchainCheck: true })
    assert.equal(paid().length, 1)
  })

  it("names no date for a block the node does not serve, instead of failing", async () => {
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.faults.blocksWithoutData = new Set([evm.latest.number])
    evm.advance(3)
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /1 of the 3 transfers to send repeat.*date unknown/s)
  })

  it("refuses a partly paid payout, or pays only the rest with --skip-paid-on-chain", async () => {
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /1 of the 3 transfers to send repeat transfers this wallet already paid.*unknown to the ledger.*--skip-paid-on-chain/s)
    assert.equal(paid().length, 0)
    assert.equal(ledger().length, 0, "nothing recorded for a refused partial match")
    await send("1790000000001.json", { skipPaidOnChain: true })
    assert.deepEqual(paid().map((t) => t.to), [utils.getAddress(PAYOUT[1].recipient), utils.getAddress(PAYOUT[2].recipient)])
    assert.equal(ledger()[0].transfers.filter((t) => t.foundOnChain).length, 1)
  })

  it("ignores identical transfers from before the period ended (last month's capped rewards)", async () => {
    await startChain(unix("2026-09-20T00:00:00Z"))
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount) // Sept 20: August's payout
    evm.advance(1, 12 * 86400) // into October
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
  })

  it("does not mistake the ledger's own earlier payouts for duplicates", async () => {
    // submissions pay 0x101 500 PNK, then removals pay 0x101 500 PNK as well
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    writePayout("1790000000005_removals_transactions.json", [PAYOUT[0]], { kind: "removals" })
    await send("1790000000005_removals_transactions.json")
    assert.equal(paid().length, 4)
  })

  it("looks back SEND_ONCHAIN_LOOKBACK_DAYS when the file's period is unknown", async () => {
    await startChain(Math.floor(Date.now() / 1000) - 2 * 86400)
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.advance(3)
    writePayout("manual.json", PAYOUT.slice(0, 1), { period: null })
    await assert.rejects(send("manual.json"), /already paid/)
  })

  it("reads the wallet's history in smaller ranges when the node limits eth_getLogs", async () => {
    evm.advance(30)
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.advance(30)
    evm.faults.getLogsMaxBlocks = 1000
    evm.advance(3000)
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /1 of the 3 transfers to send repeat transfers this wallet already paid/)
  })

  it("stops when the wallet's history cannot be read, unless the check is skipped", async () => {
    evm.faults.failNext = { eth_getLogs: 1000 }
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /Could not read the wallet's past PNK transfers.*--skip-onchain-check/s)
    assert.equal(paid().length, 0)
    await send("1790000000001.json", { skipOnchainCheck: true })
    assert.equal(paid().length, 3)
  })
})

describe("send: payouts that look alike", () => {
  const X = evmAddress(0x9826)
  const Y = evmAddress(0x1cfd)

  it("pays an identical capped removals file again for the next month", async () => {
    writePayout("1790000000010_removals_transactions.json", [{ recipient: X, amount: PNK(7000) }], { kind: "removals", period: AUGUST })
    await send("1790000000010_removals_transactions.json")
    writePayout("1790000000020_removals_transactions.json", [{ recipient: X, amount: PNK(7000) }], { kind: "removals", period: SEPTEMBER })
    await send("1790000000020_removals_transactions.json")
    assert.equal(paid().length, 2, "August and September each owed X 7,000 PNK")
    assert.deepEqual(ledger().map((r) => r.periodStart), [AUGUST.periodStart, SEPTEMBER.periodStart])
  })

  it("pays one address as remover and as ATQ requester of the same month, identical amounts", async () => {
    writePayout("1790000000030_removals_transactions.json", [{ recipient: X, amount: PNK(500) }], { kind: "removals" })
    writePayout("1790000000031_atq_transactions.json", [{ recipient: X, amount: PNK(500) }], { kind: "atq" })
    await send("1790000000030_removals_transactions.json")
    await send("1790000000031_atq_transactions.json")
    assert.equal(paid().length, 2)
  })

  it("never resumes another month's unfinished record with identical content", async () => {
    const entries = [{ recipient: X, amount: PNK(7000) }, { recipient: Y, amount: PNK(500) }]
    writePayout("1790000000010_removals_transactions.json", entries, { kind: "removals", period: AUGUST })
    evm.faults.revertTo = new Set([Y.toLowerCase()])
    await assert.rejects(send("1790000000010_removals_transactions.json"), /reverted/)
    evm.faults.revertTo = undefined
    writePayout("1790000000020_removals_transactions.json", entries, { kind: "removals", period: SEPTEMBER })
    await send("1790000000020_removals_transactions.json")
    const [august, september] = ledger()
    assert.equal(august.status, "in-progress")
    assert.equal(september.status, "completed")
    assert.equal(september.periodStart, SEPTEMBER.periodStart)
    await send("1790000000010_removals_transactions.json") // August finished on its own
    assert.equal(paid().filter((t) => t.status === 1).length, 4)
  })

  it("refuses a corrected hand-made copy of a paid file (no period to tell it apart)", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    writeJson(join(work, "files", "fixed.json"), PAYOUT.map((e, i) => ({ recipient: e.recipient, amount: i === 2 ? PNK(8).toString() : BigNumber.from(e.amount).toString() })))
    await assert.rejects(send("fixed.json"), /2 of the 3 transfers to send repeat transfers this wallet already paid.*paid by submissions for 2026-09 \(1790000000001\.json\)/s)
    assert.equal(paid().length, 3)
  })

  it("refuses a regenerated file copied without its manifest", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    const regenerated = [PAYOUT[0], { recipient: PAYOUT[1].recipient, amount: PNK(1300) }, PAYOUT[2]]
    writeJson(join(work, "files", "1790000000002.json"), regenerated.map((e) => ({ recipient: e.recipient, amount: BigNumber.from(e.amount).toString() })))
    await assert.rejects(send("1790000000002.json"), /2 of the 3 transfers to send repeat transfers/)
    assert.equal(paid().length, 3)
  })

  it("refuses a renamed copy even without the on-chain check", async () => {
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    writeJson(join(work, "files", "copy.json"), PAYOUT.map((e) => ({ recipient: e.recipient, amount: BigNumber.from(e.amount).toString() })))
    await assert.rejects(send("copy.json", { skipOnchainCheck: true }), /pays exactly the same transfers as submissions for 2026-09 \(1790000000001\.json\)/)
    assert.equal(paid().length, 3)
  })

  it("keeps other chains' records apart (a testnet trial blocks nothing on mainnet)", async () => {
    const testnet = await new MockEvm({ chainId: 10200, startTime: unix("2026-10-02T00:00:00Z") }).start()
    testnet.setTokenBalance(wallet.address, PNK(1000000))
    testnet.setNativeBalance(wallet.address, utils.parseEther("10"))
    writePayout("1790000000001.json", PAYOUT)
    const restore = setEnv({ TX_RPC_URL: testnet.url, TX_NETWORK_ID: "10200", PNK: testnet.token })
    try {
      testnet.autoMine = false
      await assert.rejects(send("1790000000001.json"), /not mined within/)
    } finally {
      restore()
    }
    await send("1790000000001.json") // mainnet, while the testnet trial is in flight
    assert.equal(paid().length, 3)
    assert.deepEqual(ledger().map((r) => r.chainId).sort(), [100, 10200])
    await testnet.stop()
  })
})

describe("send: across machines", () => {
  it("resumes an unfinished payout on a machine without its manifest", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    evm.mine()
    evm.autoMine = true
    require("fs").unlinkSync(join(work, "files", "1790000000001_generate_manifest.json")) // the other machine has only the file
    lines.length = 0
    await send("1790000000001.json")
    assert.ok(output().includes("this file pays exactly what an unfinished payout pays"))
    assert.equal(paid().length, 3)
    assert.equal(ledger().length, 1)
    assert.equal(ledger()[0].status, "completed")
    assert.equal(ledger()[0].periodStart, SEPTEMBER.periodStart, "the record keeps its period")
  })

  it("resumes, with its manifest, a payout started where the manifest was missing", async () => {
    writePayout("1790000000001.json", PAYOUT, { period: null })
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json", { allowRepeatPeriod: true }), /not mined within/)
    evm.mine()
    evm.autoMine = true
    writePayout("1790000000001.json", PAYOUT) // now with its period
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
    assert.equal(ledger().length, 1)
  })
})

describe("send: the file", () => {
  const rejects = async (content: unknown, message: RegExp) => {
    writeJson(join(work, "files", "bad.json"), content)
    await assert.rejects(send("bad.json"), message)
  }

  it("must exist in FILES_DIR", async () => {
    await assert.rejects(send("missing.json"), /\.\/files\/missing\.json not found/)
  })

  it("must be a list of { recipient, amount }", async () => {
    await rejects({ recipients: [] }, /not a transactions file/)
    await rejects([], /not a transactions file/)
    await rejects([null], /bad\.json\[0\] is not an object/)
    await rejects([{ recipient: "0x123", amount: "1" }], /invalid recipient "0x123"/)
    await rejects([{ recipient: evmAddress(0), amount: "1" }], /invalid recipient/)
    await rejects([{ recipient: evmAddress(1), amount: "1.5" }], /invalid amount "1\.5"/)
    await rejects([{ recipient: evmAddress(1), amount: "-1" }], /negative amount/)
    await rejects([{ recipient: evmAddress(1), amount: "0" }], /pays nothing/)
    writeFileSync(join(work, "files", "broken.json"), "[{")
    await assert.rejects(send("broken.json"), /is not valid JSON/)
  })

  it("must not be a reward record file", async () => {
    await rejects(
      [{ recipient: evmAddress(1), id: "x", registry: "tokens", chain: "1", chainName: "", tagAddress: "0x", amount: "1" }],
      /looks like a \*_rewards\.json .* record file/
    )
    await rejects([{ recipient: evmAddress(1), id: "x:registered", kind: "registered", itemID: "x", metadata: "", amount: "1" }], /record file/)
  })

  it("warns about a recipient listed twice, and pays both entries", async () => {
    writeJson(join(work, "files", "twice.json"), [
      { recipient: evmAddress(0x7), amount: "5" },
      { recipient: evmAddress(0x7).toUpperCase().replace("0X", "0x"), amount: "6" },
    ])
    const { duplicates } = readTransactionsFile(join(work, "files", "twice.json"))
    assert.equal(duplicates.length, 1)
    await send("twice.json", { period: "2026-09" })
    assert.equal(paid().length, 2)
    assert.ok(output().includes("WARNING: recipients listed more than once"))
  })
})

describe("send: which payout a file is", () => {
  it("reads the kind and period from the manifests next to it", () => {
    writePayout("1790000000001.json", PAYOUT)
    writePayout("1790000000002_removals_transactions.json", PAYOUT, { kind: "removals", period: AUGUST })
    writePayout("1790000000002_atq_transactions.json", PAYOUT, { kind: "atq", period: AUGUST })
    assert.deepEqual(resolveSource("1790000000001.json"), { kind: "submissions", ...SEPTEMBER, manifest: "1790000000001_generate_manifest.json" })
    assert.equal(resolveSource("1790000000002_removals_transactions.json").kind, "removals")
    assert.equal(resolveSource("1790000000002_atq_transactions.json").periodStart, AUGUST.periodStart)
  })

  it("falls back to the file name, without a period, for old runs and hand-made files", () => {
    writeJson(join(work, "files", "latest_generate_manifest.json"), { runId: "1", rewardsFile: "x", transactionsFile: "1790985007241.json" })
    assert.deepEqual(resolveSource("1790985007241.json"), { kind: "submissions", manifest: "latest_generate_manifest.json" })
    assert.deepEqual(resolveSource("9_removals_transactions.json"), { kind: "removals" })
    assert.deepEqual(resolveSource("9_atq_transactions.json"), { kind: "atq" })
    assert.deepEqual(resolveSource("123.json"), { kind: "submissions" })
    assert.deepEqual(resolveSource("payout.json"), { kind: "unknown" })
  })
})

describe("send: the September 2026 payout", () => {
  it("refuses the published files, already paid on 2026-10-06, even without a ledger", async () => {
    const dir = join(FIXTURES, "september-2026")
    const files = ["transactions.expected.json", "removals_transactions.json", "atq_transactions.json"]
    await startChain(unix("2026-10-05T00:00:00Z"))
    for (const name of files) {
      for (const t of readJson(join(dir, name))) evm.addPastTransfer(wallet.address, t.recipient, BigNumber.from(t.amount))
    }
    require("fs").mkdirSync(join(work, "files"), { recursive: true })
    copyFileSync(join(dir, "transactions.expected.json"), join(work, "files", "1790985007241.json"))
    writeJson(join(work, "files", "latest_fetch_manifest.json"), { runId: "1790985006963", ...SEPTEMBER })
    await assert.rejects(send("1790985007241.json"), /every remaining transfer of this payout is already paid/)
    assert.equal(paid().length, 0)
    assert.deepEqual(ledger(), [])
    await send("1790985007241.json", { skipPaidOnChain: true }) // recorded as paid, nothing sent
    assert.equal(paid().length, 0)
    assert.equal(ledger()[0].transfers.filter((t) => t.foundOnChain).length, 8)
  })
})

describe("--mode disbursements", () => {
  it("lists what the ledger holds", async () => {
    listDisbursementsRoutine(log)
    assert.ok(output().includes("No disbursement recorded in disbursements"))
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    lines.length = 0
    const records = listDisbursementsRoutine(log)
    assert.equal(records.length, 1)
    assert.match(output(), /^2026-09\s+submissions\s+completed\s+3\/3\s+1741\.5 PNK\s+\d{4}-\d\d-\d\d\s+1790000000001\.json\s+disbursements\/2026-09-submissions-[0-9a-f]{12}\.json$/)
  })

  it("stops on a ledger file it cannot read", async () => {
    require("fs").mkdirSync(join(work, "disbursements"))
    writeFileSync(join(work, "disbursements", "2026-09-submissions-abc.json"), "{ torn")
    assert.throws(() => listDisbursementsRoutine(log), /is not valid JSON.*Restore it from git/)
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /Restore it from git before sending/)
  })
})
