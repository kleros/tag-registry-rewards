import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils, Wallet } from "ethers"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { contentId, disbursementId, saveDisbursement } from "../../src/utils/disbursement-ledger"
import { classifyBroadcastError } from "../../src/utils/send-chain"
import { setEnv } from "../support/env"
import { listFiles } from "../support/files"
import { evmAddress, unix } from "../support/fixtures"
import {
  evm,
  installSendHarness,
  ledger,
  lines,
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

// `send` against a mock Gnosis node: runs stopped anywhere resume without
// paying twice, nodes answering oddly, and the checks before anything is signed.
installSendHarness()

describe("send: interrupted runs never pay twice", () => {
  it("finds a transaction whose broadcast answer was lost, and goes on", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.faults.failNext = {}
    // the second transfer reaches the node, but its answer is lost
    let sentRaw = 0
    const realSend = evm["sendRaw"].bind(evm)
    evm["sendRaw"] = (raw: string) => {
      sentRaw++
      if (sentRaw === 2) evm.faults.broadcastLost = 1
      return realSend(raw)
    }
    await assert.rejects(send("1790000000001.json"), /Progress is saved in disbursements\/2026-09-submissions-.*rerun the same command/s)
    assert.equal(paid().length, 2, "the node did take the second transfer")
    assert.equal(ledger()[0].transfers[1].status, "signed")
    evm["sendRaw"] = realSend
    await send("1790000000001.json")
    assert.equal(paid().length, 3, "the second transfer was not sent again")
    assert.equal(ledger()[0].status, "completed")
  })

  it("rebroadcasts the very same transaction when the first broadcast never arrived", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.faults.broadcastDropped = 1
    await assert.rejects(send("1790000000001.json"))
    const saved = ledger()[0].transfers[0]
    assert.equal(saved.status, "signed")
    assert.equal(paid().length, 0)
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
    assert.equal(paid()[0].hash, saved.txHash, "same signed bytes, same hash")
  })

  it("waits for a transaction that was not mined in time, without a new one", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /was not mined within 0\.2 s.*rerun to keep waiting/s)
    assert.equal(ledger()[0].transfers[0].status, "sent")
    evm.mine()
    evm.autoMine = true
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
    assert.equal(new Set(paid().map((t) => t.to)).size, 3)
  })

  it("rebroadcasts a saved transaction the node forgot", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    const saved = ledger()[0].transfers[0]
    evm.dropMempool()
    evm.autoMine = true
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
    assert.equal(paid()[0].hash, saved.txHash)
  })

  it("replaces a stuck transaction with a higher fee, same nonce, when the fee is raised", async () => {
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    const first = ledger()[0].transfers[0]
    const restore = setEnv({ SEND_MAX_FEE_GWEI: "5" })
    evm.autoMine = true // the node mines as soon as the replacement arrives
    try {
      await send("1790000000001.json")
    } finally {
      restore()
    }
    const t = ledger()[0].transfers[0]
    assert.equal(t.attempts!.length, 2)
    assert.equal(t.nonce, first.nonce)
    assert.notEqual(t.txHash, first.txHash)
    assert.equal(paid().length, 1, "only one of the two can be mined")
    assert.equal(paid()[0].hash, t.txHash)
  })

  it("stops for a person when the transfer's nonce was used by another transaction", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    const saved = ledger()[0].transfers[0]
    // someone sends another transaction from the wallet with that nonce
    evm.dropMempool()
    const other = await wallet.signTransaction({
      type: 2,
      chainId: 100,
      nonce: saved.nonce,
      to: evmAddress(0x999),
      value: 0,
      gasLimit: 21000,
      maxFeePerGas: 2e9,
      maxPriorityFeePerGas: 1e9,
    })
    evm["sendRaw"](other)
    evm.mine()
    evm.autoMine = true
    await assert.rejects(send("1790000000001.json"), /nonce \d+, which this transfer was signed with .* was used by another transaction/s)
    assert.equal(paid().length, 0)
    await send("1790000000001.json", { forgetUnmined: true })
    assert.equal(paid().length, 3, "each transfer paid once, the first with a new nonce")
  })

  it("stops on a reverted transfer and sends it again on the next run", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.faults.revertTo = new Set([PAYOUT[1].recipient.toLowerCase()])
    await assert.rejects(send("1790000000001.json"), /reverted, so nothing was paid by it/)
    const record = ledger()[0]
    assert.deepEqual(record.transfers.map((t) => t.status), ["confirmed", "failed", "pending"])
    assert.equal(record.transfers[1].revertedTxs!.length, 1)
    evm.faults.revertTo = undefined
    await send("1790000000001.json")
    assert.deepEqual(paid().map((t) => t.status), [1, 0, 1, 1])
    assert.equal(evm.tokenBalance(PAYOUT[1].recipient).toString(), BigNumber.from(PAYOUT[1].amount).toString())
  })

  it("records a half-paid file as paid when another machine finished it, once told so", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.faults.revertTo = new Set([PAYOUT[1].recipient.toLowerCase()])
    await assert.rejects(send("1790000000001.json"), /reverted/)
    evm.faults.revertTo = undefined
    // the rest is paid from another machine, whose ledger this one does not have
    evm.addPastTransfer(wallet.address, PAYOUT[1].recipient, PAYOUT[1].amount)
    evm.addPastTransfer(wallet.address, PAYOUT[2].recipient, PAYOUT[2].amount)
    await assert.rejects(send("1790000000001.json"), /every remaining transfer of this payout is already paid.*--skip-paid-on-chain/s)
    assert.equal(ledger()[0].status, "in-progress")
    await send("1790000000001.json", { skipPaidOnChain: true })
    const [record] = ledger()
    assert.equal(record.status, "completed")
    assert.deepEqual(record.transfers.map((t) => !!t.foundOnChain), [false, true, true])
    assert.equal(paid().filter((t) => t.status === 1).length, 1, "this machine sent only the first transfer")
  })

  it("keeps a transaction whose nonce another one took during the run, and resends it only with --forget-unmined", async () => {
    writePayout("1790000000001.json", PAYOUT)
    // another transaction from the wallet takes the next nonce right after the run reads it
    const realSend = evm["sendRaw"].bind(evm)
    let first = true
    evm["sendRaw"] = (raw: string) => {
      if (first) {
        first = false
        evm.nonces.set(wallet.address.toLowerCase(), 1)
      }
      return realSend(raw)
    }
    await assert.rejects(send("1790000000001.json"), /nonce 0, which this transfer was signed with .* was used by another transaction.*--forget-unmined/s)
    evm["sendRaw"] = realSend
    const saved = ledger()[0].transfers[0]
    assert.equal(saved.status, "signed", "kept: whether it can still be mined is for a person to check")
    await assert.rejects(send("1790000000001.json"), /--forget-unmined/)
    await send("1790000000001.json", { forgetUnmined: true })
    assert.equal(paid().length, 3)
    const t = ledger()[0].transfers[0]
    assert.deepEqual(t.forgottenTxs, saved.attempts)
    assert.notEqual(t.nonce, 0)
  })

  it("never forgets a transaction it just broadcast, even with --forget-unmined", async () => {
    // --forget-unmined given for one stuck transfer, while another one's fresh
    // broadcast is mined but answered "nonce too low" (a proxy's retry), and a
    // lagging backend shows neither its receipt nor its block yet
    const erc20 = new utils.Interface(["function transfer(address to, uint256 amount)"])
    const [A, B] = PAYOUT
    writePayout("1790000000001.json", [A, B])
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    evm.dropMempool()
    const other = await wallet.signTransaction({ type: 2, chainId: 100, nonce: 0, to: evmAddress(0x999), value: 0, gasLimit: 21000, maxFeePerGas: 2e9, maxPriorityFeePerGas: 1e9 })
    evm["sendRaw"](other) // takes A's nonce
    evm.mine()
    evm.autoMine = true
    const realSend = evm["sendRaw"].bind(evm)
    const realHandle = evm["handle"].bind(evm)
    let staleHead: number | null = null
    evm["handle"] = (method: string, params: unknown[]) =>
      method === "eth_blockNumber" && staleHead !== null ? utils.hexValue(staleHead) : realHandle(method, params)
    let sendsToB = 0
    evm["sendRaw"] = (raw: string) => {
      const to = String(erc20.decodeFunctionData("transfer", utils.parseTransaction(raw).data)[0]).toLowerCase()
      if (to !== B.recipient.toLowerCase() || ++sendsToB > 1) return realSend(raw)
      evm.faults.receiptLag = 1e9 // this node never returns its receipt
      const head = evm.latest.number
      realSend(raw) // mined
      evm.faults.receiptLag = 0
      staleHead = head
      throw { code: -32000, message: "nonce too low" }
    }
    await assert.rejects(send("1790000000001.json", { forgetUnmined: true }), /was used by another transaction/)
    const t = ledger()[0].transfers[1]
    assert.equal(t.status, "signed", "kept, not forgotten")
    assert.equal(t.forgottenTxs, undefined)
    staleHead = null // the backend catches up
    await send("1790000000001.json", { forgetUnmined: true })
    assert.equal(paid().filter((p) => p.to === utils.getAddress(B.recipient) && p.status === 1).length, 1, "B paid once")
    assert.equal(ledger()[0].status, "completed")
  })

  it("never forgets a saved transaction its own rebroadcast was answered nonce too low for, even with --forget-unmined", async () => {
    // the rerun's rebroadcast is mined, but the answer is "nonce too low" and a
    // lagging backend shows neither its receipt nor its block yet
    const [A] = PAYOUT
    writePayout("1790000000001.json", [A])
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    evm.dropMempool()
    evm.autoMine = true
    const realSend = evm["sendRaw"].bind(evm)
    const realHandle = evm["handle"].bind(evm)
    let staleHead: number | null = null
    evm["handle"] = (method: string, params: unknown[]) =>
      method === "eth_blockNumber" && staleHead !== null ? utils.hexValue(staleHead) : realHandle(method, params)
    let first = true
    evm["sendRaw"] = (raw: string) => {
      if (!first) return realSend(raw)
      first = false
      evm.faults.receiptLag = 1e9
      const head = evm.latest.number
      realSend(raw) // mined
      evm.faults.receiptLag = 0
      staleHead = head
      throw { code: -32000, message: "nonce too low" }
    }
    await assert.rejects(send("1790000000001.json", { forgetUnmined: true }), /was used by another transaction/)
    assert.equal(ledger()[0].transfers[0].forgottenTxs, undefined)
    staleHead = null // the backend catches up
    await send("1790000000001.json", { forgetUnmined: true })
    assert.equal(paid().filter((p) => p.status === 1 && p.to === utils.getAddress(A.recipient)).length, 1, "paid once")
    assert.equal(ledger()[0].status, "completed")
  })

  it("never takes an unrelated payment of the same amount to the same recipient for a transfer whose nonce went elsewhere", async () => {
    const R = { recipient: evmAddress(0x5a), amount: PNK(500) }
    writePayout("1790000000001.json", [R])
    evm.addPastTransfer(wallet.address, R.recipient, R.amount) // an unrelated payment, under another nonce
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json", { skipOnchainCheck: true }), /not mined within/)
    const saved = ledger()[0].transfers[0]
    evm.dropMempool()
    const other = await wallet.signTransaction({ type: 2, chainId: 100, nonce: saved.nonce, to: evmAddress(0x999), value: 0, gasLimit: 21000, maxFeePerGas: 2e9, maxPriorityFeePerGas: 1e9 })
    evm["sendRaw"](other) // takes its nonce, paying nobody
    evm.mine()
    evm.autoMine = true
    const refused = await send("1790000000001.json").then(() => null, (e: Error) => e)
    assert.match(String(refused && refused.message), /was used by another transaction.*--forget-unmined/s)
    assert.doesNotMatch(String(refused && refused.message), /may be this transfer/)
    await assert.rejects(send("1790000000001.json", { skipPaidOnChain: true }), /was used by another transaction/, "not taken for this transfer")
    await send("1790000000001.json", { forgetUnmined: true }) // nothing stops forgetting it now
    const [record] = ledger()
    assert.equal(record.status, "completed")
    assert.equal(record.transfers[0].foundOnChain, undefined)
    assert.deepEqual(record.transfers[0].forgottenTxs, saved.attempts)
    assert.equal(paid().filter((p) => p.status === 1 && p.to === utils.getAddress(R.recipient)).length, 1, "this payout paid R once")
  })

  it("resumes saved transactions lowest nonce first", async () => {
    writePayout("1790000000001.json", PAYOUT.slice(0, 2))
    // a run signed #2 with nonce 0 and #1 with nonce 1 (#1 had reverted and was
    // signed again), then stopped before broadcasting either
    const erc20 = new utils.Interface(["function transfer(address to, uint256 amount)"])
    const fee = { maxFeePerGas: utils.parseUnits("2", "gwei"), maxPriorityFeePerGas: utils.parseUnits("1", "gwei") }
    const signed = async (entry: { recipient: string; amount: BigNumber | string }, nonce: number) => {
      const raw = await wallet.signTransaction({
        type: 2,
        chainId: 100,
        nonce,
        to: evm.token,
        value: 0,
        data: erc20.encodeFunctionData("transfer", [entry.recipient, entry.amount]),
        gasLimit: 100000,
        ...fee,
      })
      const hash = utils.keccak256(raw)
      return {
        recipient: utils.getAddress(entry.recipient),
        amount: BigNumber.from(entry.amount).toString(),
        status: "signed" as const,
        nonce,
        txHash: hash,
        rawTx: raw,
        attempts: [hash],
        maxFeePerGas: fee.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString(),
      }
    }
    const transfers = [await signed(PAYOUT[0], 1), await signed(PAYOUT[1], 0)]
    const content = contentId(100, evm.token, transfers)
    const now = new Date().toISOString()
    saveDisbursement({
      version: 1,
      id: disbursementId(content, "submissions", SEPTEMBER.periodStart, SEPTEMBER.periodEnd),
      contentId: content,
      file: "1790000000001.json",
      fileSha256: "",
      kind: "submissions",
      ...SEPTEMBER,
      chainId: 100,
      token: evm.token,
      from: wallet.address,
      status: "in-progress",
      total: transfers.reduce((acc, t) => acc.add(t.amount), BigNumber.from(0)).toString(),
      createdAt: now,
      updatedAt: now,
      transfers,
    })
    await send("1790000000001.json")
    assert.equal(paid().length, 2)
    assert.equal(ledger()[0].status, "completed")
  })

  it("resumes with a wallet funded exactly, when a mined transfer's receipt is missing", async () => {
    await startChain(Math.floor(Date.now() / 1000) - 3600) // logs are read from the run's start
    evm.setTokenBalance(wallet.address, PNK("1741.5")) // the payout, to the wei
    evm.faults.receiptLag = 1e9 // the first transfer is mined, but this node never returns its receipt
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /was not mined within/)
    evm.faults.receiptLag = 0
    await send("1790000000001.json") // its PNK already left the wallet: not counted again
    assert.equal(paid().length, 3)
    assert.equal(ledger()[0].status, "completed")
    assert.equal(evm.tokenBalance(wallet.address), BigInt(0))
  })

  it("checks the funds again before sending a forgotten transfer anew", async () => {
    await startChain(Math.floor(Date.now() / 1000) - 3600) // logs are read from the run's start
    writePayout("1790000000001.json", PAYOUT.slice(0, 1)) // 500 PNK
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    const saved = ledger()[0].transfers[0]
    // another transaction takes its nonce, and leaves the wallet 400 PNK
    evm.dropMempool()
    const erc20 = new utils.Interface(["function transfer(address to, uint256 amount)"])
    const other = await wallet.signTransaction({
      type: 2,
      chainId: 100,
      nonce: saved.nonce,
      to: evm.token,
      value: 0,
      data: erc20.encodeFunctionData("transfer", [evmAddress(0x999), PNK(1000000 - 400)]),
      gasLimit: 90000,
      maxFeePerGas: utils.parseUnits("2", "gwei"),
      maxPriorityFeePerGas: utils.parseUnits("1", "gwei"),
    })
    evm["sendRaw"](other)
    evm.mine()
    evm.autoMine = true
    await assert.rejects(send("1790000000001.json", { forgetUnmined: true }), /not sending it again: the wallet holds 400 PNK, less than the 500 PNK/)
    assert.equal(paid().filter((t) => t.status === 0).length, 0, "nothing broadcast that would revert")
    assert.equal(ledger()[0].transfers[0].status, "pending", "forgotten: the next run sends it, once the wallet is funded")
    evm.setTokenBalance(wallet.address, PNK(500))
    await send("1790000000001.json")
    assert.equal(ledger()[0].status, "completed")
  })

  it("refuses to resume from another wallet", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    const other = Wallet.createRandom()
    const restore = setEnv({ WALLET_PRIVATE_KEY: other.privateKey })
    try {
      await assert.rejects(send("1790000000001.json"), /was started from 0x[0-9a-fA-F]{40}, and WALLET_PRIVATE_KEY is now/)
    } finally {
      restore()
    }
  })

  it("refuses to resume a ledger record edited after it was written (a bad merge pays nobody)", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.faults.revertTo = new Set([PAYOUT[1].recipient.toLowerCase()])
    await assert.rejects(send("1790000000001.json"), /reverted/)
    evm.faults.revertTo = undefined
    const dir = join(work, "disbursements")
    const [name] = listFiles(dir).filter((n) => n.endsWith(".json"))
    const record = JSON.parse(readFileSync(join(dir, name)).toString())
    const intruder = evmAddress(0xbad)
    record.transfers[2].recipient = utils.getAddress(intruder)
    writeFileSync(join(dir, name), JSON.stringify(record, null, 2))
    await assert.rejects(send("1790000000001.json"), /does not match its own ids.*Restore it from git before sending/s)
    assert.equal(evm.tokenBalance(intruder), BigInt(0))
    assert.equal(paid().filter((t) => t.status === 1).length, 1)
  })

  it("refuses a new payout while another one has transactions in flight", async () => {
    writePayout("1790000000001.json", PAYOUT)
    writePayout("1790000000006_removals_transactions.json", [{ recipient: evmAddress(0x5), amount: PNK(1) }], { kind: "removals" })
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    await assert.rejects(send("1790000000006_removals_transactions.json"), /has transactions in flight\. Rerun send on that file first/)
  })

  it("only warns about another payout left half-paid with nothing in flight", async () => {
    writePayout("1790000000001.json", PAYOUT)
    writePayout("1790000000006_removals_transactions.json", [{ recipient: evmAddress(0x5), amount: PNK(1) }], { kind: "removals" })
    evm.faults.revertTo = new Set([PAYOUT[1].recipient.toLowerCase()])
    await assert.rejects(send("1790000000001.json"), /reverted/)
    evm.faults.revertTo = undefined
    await send("1790000000006_removals_transactions.json")
    assert.ok(output().includes("WARNING: not finished: submissions for 2026-09 (1790000000001.json): in progress, 1/3 transfers"))
    await send("1790000000001.json")
    assert.deepEqual(ledger().map((r) => r.status), ["completed", "completed"])
  })

  it("refuses to run next to another send on the same ledger", async () => {
    writePayout("1790000000001.json", PAYOUT)
    writeFileSync(join(work, "disbursements-lock-placeholder"), "")
    require("fs").mkdirSync(join(work, "disbursements"), { recursive: true })
    writeFileSync(join(work, "disbursements", ".lock"), String(process.ppid))
    await assert.rejects(send("1790000000001.json"), /\[disbursements\] Another run \(pid \d+\) is using/)
    assert.equal(paid().length, 0)
  })
})

describe("send: what nodes answer", () => {
  it("confirms a transfer whose broadcast was retried by a proxy after it was mined (nonce too low)", async () => {
    const realSend = evm["sendRaw"].bind(evm)
    let n = 0
    evm["sendRaw"] = (raw: string) => {
      n++
      const result = realSend(raw)
      if (n === 2) throw { code: -32000, message: "nonce too low" }
      return result
    }
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    assert.equal(paid().length, 3, "each transfer paid once")
    assert.ok(ledger()[0].transfers.every((t) => t.status === "confirmed"))
  })

  it("keeps a transfer the node refused as underpriced, and sends it with the raised fees", async () => {
    const realSend = evm["sendRaw"].bind(evm)
    evm["sendRaw"] = () => {
      throw { code: -32000, message: "transaction underpriced" }
    }
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /refused the transaction as underpriced.*Raise SEND_MAX_FEE_GWEI and SEND_MAX_PRIORITY_FEE_GWEI/s)
    const first = ledger()[0].transfers[0]
    assert.equal(first.status, "signed")
    evm["sendRaw"] = realSend
    const restore = setEnv({ SEND_MAX_FEE_GWEI: "5", SEND_MAX_PRIORITY_FEE_GWEI: "2" })
    try {
      await send("1790000000001.json")
    } finally {
      restore()
    }
    const t = ledger()[0].transfers[0]
    assert.equal(t.nonce, first.nonce, "same nonce")
    assert.equal(t.maxPriorityFeePerGas, utils.parseUnits("2", "gwei").toString())
    assert.equal(paid().length, 3)
  })

  it("replaces a stuck transaction within SEND_MAX_FEE_GWEI, raising both fees as pools require", async () => {
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"))
    evm.autoMine = true
    let restore = setEnv({ SEND_MAX_FEE_GWEI: "2.1" }) // a 5% raise: too little for a replacement
    try {
      await assert.rejects(send("1790000000001.json"), /needs a fee cap of at least 2\.25 gwei \(12\.5% above the 2\.0 gwei.*Raise SEND_MAX_FEE_GWEI/s)
    } finally {
      restore()
    }
    restore = setEnv({ SEND_MAX_FEE_GWEI: "3" })
    try {
      await send("1790000000001.json")
    } finally {
      restore()
    }
    const t = ledger()[0].transfers[0]
    assert.equal(t.maxFeePerGas, utils.parseUnits("3", "gwei").toString(), "never above the configured cap")
    assert.equal(t.maxPriorityFeePerGas, utils.parseUnits("1.125", "gwei").toString())
    assert.equal(paid().length, 1)
  })

  it("confirms from the wallet's Transfer logs a mined transaction whose receipt the node lacks", async () => {
    await startChain(Math.floor(Date.now() / 1000) - 3600) // logs are read from the run's start
    evm.faults.receiptLag = 1e9 // this node never returns these receipts
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    await assert.rejects(send("1790000000001.json"), /was not mined within/)
    await send("1790000000001.json") // its nonce is used: the logs show the transaction mined
    assert.equal(paid().length, 1, "not sent again")
    assert.equal(ledger()[0].status, "completed")
    assert.ok(output().includes("is on-chain (the node had no receipt for it)"))
  })

  it("does not forget a transaction when an identical transfer unknown to the ledger is on-chain", async () => {
    await startChain(Math.floor(Date.now() / 1000) - 3600)
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    const saved = ledger()[0].transfers[0]
    // the same transfer, signed elsewhere with that nonce, is what got mined
    evm.dropMempool()
    const erc20 = new utils.Interface(["function transfer(address to, uint256 amount)"])
    const elsewhere = await wallet.signTransaction({
      type: 2,
      chainId: 100,
      nonce: saved.nonce,
      to: evm.token,
      value: 0,
      data: erc20.encodeFunctionData("transfer", [PAYOUT[0].recipient, PAYOUT[0].amount]),
      gasLimit: 90000,
      maxFeePerGas: utils.parseUnits("2", "gwei"),
      maxPriorityFeePerGas: utils.parseUnits("1", "gwei"),
    })
    evm["sendRaw"](elsewhere)
    evm.mine()
    evm.autoMine = true
    await assert.rejects(send("1790000000001.json", { forgetUnmined: true }), /not forgetting it: tx 0x[0-9a-f]{64} .* may be this transfer/s)
    assert.equal(paid().length, 1, "paid once, by the other transaction")
  })

  it("records a transfer paid by a same-nonce transaction signed elsewhere, once told so (--skip-paid-on-chain)", async () => {
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    writePayout("1790000000006_removals_transactions.json", [{ recipient: evmAddress(0x5), amount: PNK(1) }], { kind: "removals" })
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    const saved = ledger()[0].transfers[0]
    // another machine replaced it with higher fees, and its ledger never came back
    evm.dropMempool()
    const erc20 = new utils.Interface(["function transfer(address to, uint256 amount)"])
    const replacement = await wallet.signTransaction({
      type: 2,
      chainId: 100,
      nonce: saved.nonce,
      to: evm.token,
      value: 0,
      data: erc20.encodeFunctionData("transfer", [PAYOUT[0].recipient, PAYOUT[0].amount]),
      gasLimit: 100000,
      maxFeePerGas: utils.parseUnits("3", "gwei"),
      maxPriorityFeePerGas: utils.parseUnits("1.5", "gwei"),
    })
    evm["sendRaw"](replacement)
    evm.mine()
    evm.autoMine = true
    await assert.rejects(send("1790000000001.json"), /was used by another transaction.*may be this transfer.*--skip-paid-on-chain to record it as paid/s)
    await assert.rejects(send("1790000000001.json", { forgetUnmined: true }), /not forgetting it: .*--skip-paid-on-chain/s)
    await assert.rejects(send("1790000000006_removals_transactions.json"), /in flight/)
    await send("1790000000001.json", { skipPaidOnChain: true })
    const [record] = ledger()
    assert.equal(record.status, "completed")
    assert.equal(record.transfers[0].foundOnChain, true)
    assert.equal(record.transfers[0].txHash, utils.keccak256(replacement))
    assert.deepEqual(record.transfers[0].forgottenTxs, saved.attempts)
    assert.equal(paid().length, 1, "paid once, by the transaction signed elsewhere")
    await send("1790000000006_removals_transactions.json") // no longer blocked
    assert.equal(paid().length, 2)
  })

  it("checks the wallet's history on a node that pruned blocks older than the period's end", async () => {
    await startChain(unix("2026-09-20T00:00:00Z"))
    evm.advance(2500)
    evm.advance(1, 11 * 86400) // October
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.advance(100)
    evm.faults.prunedBelow = 2000 // all in September
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /1 of the 3 transfers to send repeat transfers/)
  })

  it("refuses when the node no longer serves the blocks since the period's end", async () => {
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.advance(2500)
    evm.faults.prunedBelow = 2000 // October's first blocks, the transfer among them
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /Could not read the wallet's past PNK transfers.*no longer serves.*2026-10-01.*--skip-onchain-check/s)
    assert.equal(paid().length, 0)
  })

  it("stops, rather than guess where the history starts, when the node lacks a block the search reads", async () => {
    await startChain(unix("2026-09-30T00:00:00Z"))
    evm.advance(1, 86400 + 3600) // October
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount)
    evm.advance(20)
    evm.faults.blocksWithoutData = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) // a lagging node
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    await assert.rejects(send("1790000000001.json"), /Could not read the wallet's past PNK transfers.*did not return block \d+.*Retry/s)
    assert.equal(paid().length, 0)
  })

  it("never counts a payment from before the period's end as one of this payout's", async () => {
    await startChain(unix("2026-09-30T00:00:00Z"))
    evm.addPastTransfer(wallet.address, PAYOUT[0].recipient, PAYOUT[0].amount) // September: another payout, the same transfer
    evm.advance(10)
    evm.advance(1, 86400 + 3600) // October
    evm.advance(20)
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    evm.faults.blocksWithoutData = new Set(Array.from({ length: 16 }, (_, i) => i + 5)) // blocks 5 to 20
    await assert.rejects(send("1790000000001.json", { skipPaidOnChain: true }), /did not return block/)
    assert.equal(ledger().length, 0, "not recorded as paid")
    evm.faults.blocksWithoutData = undefined
    await send("1790000000001.json", { skipPaidOnChain: true })
    assert.equal(paid().length, 1, "sent: September's transfer belongs to another payout")
    assert.ok(output().includes("none of these transfers is among the wallet's PNK transfers since 2026-10-01"))
  })

  it("reads a receipt without status from its Transfer event", async () => {
    evm.faults.receiptsWithoutStatus = true
    evm.faults.revertTo = new Set([PAYOUT[1].recipient.toLowerCase()])
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /reverted/)
    assert.deepEqual(ledger()[0].transfers.map((t) => t.status), ["confirmed", "failed", "pending"])
  })

  it("waits, rather than send again, when a receipt has neither status nor logs", async () => {
    evm.faults.receiptsWithoutStatus = true
    evm.faults.receiptsWithoutLogs = true
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /was not mined within/)
    assert.equal(ledger()[0].transfers[0].status, "sent", "not taken for a revert")
    evm.faults.receiptsWithoutStatus = false
    evm.faults.receiptsWithoutLogs = false
    await send("1790000000001.json")
    assert.equal(paid().length, 3, "each transfer paid once")
  })

  it("names this payout's own transaction when one recorded as reverted is found paying on-chain", async () => {
    // a node whose receipt says reverted for a transfer that went through
    const realHandle = evm["handle"].bind(evm)
    let lying = true
    evm["handle"] = (method: string, params: unknown[]) => {
      const answer = realHandle(method, params) as { status?: string } | null
      return method === "eth_getTransactionReceipt" && lying && answer ? { ...answer, status: "0x0" } : answer
    }
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    await assert.rejects(send("1790000000001.json"), /reverted, so nothing was paid by it/)
    lying = false
    await assert.rejects(send("1790000000001.json"), /this payout's own transaction, recorded as reverted or never mined, yet it paid/)
    assert.equal(paid().length, 1, "not sent again")
  })

  it("tells apart the answers of geth, Nethermind, Erigon and Besu", () => {
    const cases: [string, string | null][] = [
      ["already known", "known"],
      ["AlreadyKnown", "known"],
      ["ALREADY_EXISTS: already known", "known"],
      ["INTERNAL_ERROR: existing txn with same hash", "known"],
      ["Known transaction", "known"],
      ["nonce too low: next nonce 5, tx nonce 4", "nonce-too-low"],
      ["OldNonce", "nonce-too-low"],
      ["INTERNAL_ERROR: nonce too low", "nonce-too-low"],
      ["replacement transaction underpriced", "replacement-underpriced"],
      ["ReplacementNotAllowed", "replacement-underpriced"],
      ["INTERNAL_ERROR: could not replace existing tx", "replacement-underpriced"],
      ["transaction underpriced", "underpriced"],
      ["FeeTooLow", "underpriced"],
      ["FEE_TOO_LOW: underpriced", "underpriced"],
      ["max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 7", "underpriced"],
      ["insufficient funds for gas * price + value", null],
      ["nonce too high", null],
    ]
    for (const [message, expected] of cases) {
      assert.equal(classifyBroadcastError({ code: -32000, error: { code: -32000, message } }), expected, message)
      assert.equal(classifyBroadcastError(new Error(`processing response error (body="{\\"error\\":{\\"message\\":\\"${message}\\"}}")`)), expected, `${message}, in a body`)
    }
  })

  it("waits for a saved transaction that an Erigon node already holds (existing txn with same hash)", async () => {
    evm.faults.erigon = true
    writePayout("1790000000001.json", PAYOUT.slice(0, 1))
    evm.autoMine = false
    await assert.rejects(send("1790000000001.json"), /not mined within/)
    const realSend = evm["sendRaw"].bind(evm)
    const answers: string[] = []
    evm["sendRaw"] = (raw: string) => {
      try {
        return realSend(raw)
      } catch (err) {
        answers.push((err as { message: string }).message)
        setImmediate(() => evm.mine()) // mined while send waits for it
        throw err
      }
    }
    await send("1790000000001.json") // rebroadcasts the very same transaction
    assert.deepEqual(answers, ["INTERNAL_ERROR: existing txn with same hash"])
    assert.equal(paid().length, 1)
    assert.equal(ledger()[0].status, "completed")
  })

  it("never takes a transfer this run just paid for another entry's payment (a recipient listed twice)", async () => {
    const A = { recipient: evmAddress(0x7), amount: PNK(5) }
    writePayout("1790000000001.json", [A, A])
    // right after the first entry is paid, another transaction takes the next nonce
    const realSend = evm["sendRaw"].bind(evm)
    let sends = 0
    evm["sendRaw"] = (raw: string) => {
      const result = realSend(raw)
      if (++sends === 1) evm.nonces.set(wallet.address.toLowerCase(), 2)
      return result
    }
    await assert.rejects(send("1790000000001.json", { skipPaidOnChain: true }), /was used by another transaction/)
    assert.equal(ledger()[0].transfers[1].foundOnChain, undefined, "the first entry's payment is not the second's")
    assert.equal(paid().length, 1)
  })

  it("refuses, rather than read part of the history, when the RPC's backends disagree on the latest block", async () => {
    await startChain(unix("2026-09-30T23:00:00Z"))
    evm.advance(1000) // into October
    const realHandle = evm["handle"].bind(evm)
    evm["handle"] = (method: string, params: unknown[]) => (method === "eth_blockNumber" ? utils.hexValue(10) : realHandle(method, params))
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(send("1790000000001.json"), /Could not read the wallet's past PNK transfers.*backends disagree/s)
    assert.equal(paid().length, 0)
  })

  it("refuses when the node's latest block predates the period's end (a node behind)", async () => {
    await startChain(unix("2026-09-25T00:00:00Z")) // its newest block is of September
    writePayout("1790000000001.json", PAYOUT)
    await assert.rejects(
      send("1790000000001.json"),
      /Could not read the wallet's past PNK transfers.*latest block, \d+, is of 2026-09-25.*before 2026-10-01.*lags behind/s
    )
    assert.equal(paid().length, 0)
  })

  it("keeps waiting for a receipt through RPC errors", async () => {
    evm.faults.failNext = { eth_getTransactionReceipt: 3 }
    writePayout("1790000000001.json", PAYOUT)
    await send("1790000000001.json")
    assert.equal(paid().length, 3)
  })
})

describe("send: checks before anything is signed", () => {
  it("dry run: shows the plan and every check, signs and records nothing", async () => {
    writePayout("1790000000001.json", PAYOUT)
    const result = await send("1790000000001.json", { dryRun: true })
    assert.equal(result.sent, 0)
    assert.equal(paid().length, 0)
    assert.ok(!existsSync(join(work, "disbursements")))
    assert.ok(output().includes("Dry run: would send 3 transfer(s), 1741.5 PNK"))
    assert.ok(output().includes("Already paid: none of these transfers is among the wallet's PNK transfers"))
    await send("1790000000001.json")
    await assert.rejects(send("1790000000001.json", { dryRun: true }), /already disbursed/)
  })

  it("dry run without a wallet key still checks the file and the ledger", async () => {
    writePayout("1790000000001.json", PAYOUT)
    const restore = setEnv({ WALLET_PRIVATE_KEY: undefined })
    try {
      await send("1790000000001.json", { dryRun: true })
      assert.ok(output().includes("Skipping the wallet and on-chain checks: WALLET_PRIVATE_KEY is not set"))
      await assert.rejects(send("1790000000001.json"), /WALLET_PRIVATE_KEY is not set/)
    } finally {
      restore()
    }
  })

  it("dry run --from checks any address read-only, without its key", async () => {
    for (const e of PAYOUT) evm.addPastTransfer(wallet.address, e.recipient, e.amount)
    writePayout("1790000000001.json", PAYOUT)
    const restore = setEnv({ WALLET_PRIVATE_KEY: undefined })
    try {
      await assert.rejects(send("1790000000001.json", { dryRun: true, from: wallet.address }), /every remaining transfer of this payout is already paid/)
      assert.ok(output().includes(`From: ${wallet.address}`))
      assert.deepEqual(listFiles(join(work, "disbursements")), [], "a dry run records nothing")
      const unpaid = evmAddress(0xf00) // a funded wallet that paid nothing
      evm.setTokenBalance(unpaid, PNK(5000))
      evm.setNativeBalance(unpaid, PNK(1))
      lines.length = 0
      const result = await send("1790000000001.json", { dryRun: true, from: unpaid })
      assert.equal(result.sent, 0)
      assert.ok(output().includes("Dry run: would send 3 transfer(s)"))
      await assert.rejects(send("1790000000001.json", { from: unpaid }), /--from only works with --dry-run/)
      await assert.rejects(send("1790000000001.json", { dryRun: true, from: "0xnope" }), /--from "0xnope" is not an address/)
    } finally {
      restore()
    }
  })

  it("refuses when the wallet lacks the PNK or the gas", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.setTokenBalance(wallet.address, PNK(1000))
    await assert.rejects(send("1790000000001.json"), /holds 1000 PNK, less than the 1741\.5 PNK to send/)
    evm.setTokenBalance(wallet.address, PNK(5000))
    evm.setNativeBalance(wallet.address, "1")
    await assert.rejects(send("1790000000001.json"), /native token for gas, less than the 0\.0006 these transfers may use/)
    assert.equal(paid().length, 0)
    assert.deepEqual(listFiles(join(work, "disbursements")), [], "nothing recorded before the checks pass (the lock is released)")
  })

  it("refuses when the base fee is above SEND_MAX_FEE_GWEI", async () => {
    writePayout("1790000000001.json", PAYOUT)
    evm.baseFee = BigInt(3e9)
    evm.advance(1)
    await assert.rejects(send("1790000000001.json"), /base fee is 3\.0 gwei, above SEND_MAX_FEE_GWEI \(2\.0\)/)
  })

  it("names a PNK setting that is not an address", async () => {
    writePayout("1790000000001.json", PAYOUT)
    const restore = setEnv({ PNK: "pinakion" })
    try {
      await assert.rejects(send("1790000000001.json"), /PNK="pinakion" is not a token address/)
    } finally {
      restore()
    }
  })

  it("refuses an RPC on another chain", async () => {
    writePayout("1790000000001.json", PAYOUT)
    const restore = setEnv({ TX_NETWORK_ID: "10200" })
    try {
      await assert.rejects(send("1790000000001.json"), /answers for chain 100, not TX_NETWORK_ID=10200/)
    } finally {
      restore()
    }
  })

  it("rejects malformed send settings", async () => {
    writePayout("1790000000001.json", PAYOUT)
    for (const [key, value, message] of [
      ["SEND_MAX_FEE_GWEI", "cheap", /Invalid SEND_MAX_FEE_GWEI="cheap"/],
      ["SEND_MAX_PRIORITY_FEE_GWEI", "3", /must not exceed SEND_MAX_FEE_GWEI/],
      ["SEND_GAS_LIMIT", "1.5", /Invalid SEND_GAS_LIMIT/],
      ["SEND_RECEIPT_TIMEOUT_SECONDS", "-5", /Invalid SEND_RECEIPT_TIMEOUT_SECONDS="-5"/],
    ] as [string, string, RegExp][]) {
      const restore = setEnv({ [key]: value })
      try {
        await assert.rejects(send("1790000000001.json"), message)
      } finally {
        restore()
      }
    }
  })
})

