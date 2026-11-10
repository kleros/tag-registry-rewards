import { afterEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils, Wallet } from "ethers"
import { request as httpRequest, Server } from "http"
import { AddressInfo } from "net"
import { join } from "path"
import { createDisburseServer } from "../../src/disburse/server"
import { DisburseSession } from "../../src/disburse/session"
import { sendRoutine } from "../../src/send-routine"
import { setEnv } from "../support/env"
import { writeJson } from "../support/files"
import { evmAddress } from "../support/fixtures"
import { evm, installSendHarness, ledger, log, paid, PNK, SEPTEMBER, wallet, work } from "../support/send-harness"

// The disburse page (`--mode disburse-page`): its own script (static/page.js,
// the code the browser runs) against the real server and session, a mock
// Gnosis node, and a stand-in browser wallet that signs with the test key.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require("../../src/disburse/static/page.js")

installSendHarness()

type Entry = { recipient: string; amount: BigNumber }
type Tx = { to: string; data: string; value?: string }

// A folder of files/ as generate and removals leave it: the transactions
// files, their manifests, and the latest_* manifests the page reads.
const writeFolder = (folder: string, payouts: { submissions?: Entry[]; removals?: Entry[]; atq?: Entry[] }, runId = 1790000000001): void => {
  const dir = join(work, "files", folder)
  const rows = (entries: Entry[]) => entries.map((e) => ({ amount: BigNumber.from(e.amount), recipient: e.recipient }))
  if (payouts.submissions) {
    writeJson(join(dir, `${runId}.json`), rows(payouts.submissions), false)
    const manifest = { runId: String(runId), ...SEPTEMBER, rewardsFile: `${runId}_rewards.json`, transactionsFile: `${runId}.json` }
    writeJson(join(dir, `${runId}_generate_manifest.json`), manifest)
    writeJson(join(dir, "latest_generate_manifest.json"), manifest)
  }
  if (payouts.removals || payouts.atq) {
    const r = runId + 1
    const manifest: { [key: string]: string } = { runId: String(r), ...SEPTEMBER }
    if (payouts.removals) {
      writeJson(join(dir, `${r}_removals_transactions.json`), rows(payouts.removals), false)
      manifest.transactionsFile = `${r}_removals_transactions.json`
    }
    if (payouts.atq) {
      writeJson(join(dir, `${r}_atq_transactions.json`), rows(payouts.atq), false)
      manifest.atqTransactionsFile = `${r}_atq_transactions.json`
    }
    writeJson(join(dir, `${r}_removals_manifest.json`), manifest)
    writeJson(join(dir, "latest_removals_manifest.json"), manifest)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC answers
const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
  const response = await fetch(evm.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const json = await response.json()
  if (json.error) throw json.error
  return json.result
}

// A browser wallet (EIP-1193) holding the test key: it signs and broadcasts
// in one step, as Rabby and MetaMask do, and can reject, fail, or sign
// something else than it was asked.
class FakeWallet {
  chainId = 100
  sent: string[] = []
  reject = false
  fail: string | null = null
  noSwitch = false
  tamper: ((tx: Tx) => Tx) | null = null
  afterSend: (() => Promise<void>) | null = null
  private listeners: { [event: string]: ((value: unknown) => void)[] } = {}

  constructor(readonly signer: Wallet) {}

  on(event: string, listener: (value: unknown) => void): void {
    this.listeners[event] = (this.listeners[event] || []).concat(listener)
  }

  async signAndSend(tx: Tx, fees = { max: "2", tip: "1" }, nonce?: number): Promise<string> {
    const n = nonce === undefined ? Number(await rpc("eth_getTransactionCount", [this.signer.address, "pending"])) : nonce
    const raw = await this.signer.signTransaction({
      type: 2,
      chainId: this.chainId,
      nonce: n,
      to: tx.to,
      data: tx.data,
      value: tx.value || 0,
      gasLimit: 100000,
      maxFeePerGas: utils.parseUnits(fees.max, "gwei"),
      maxPriorityFeePerGas: utils.parseUnits(fees.tip, "gwei"),
    })
    return rpc("eth_sendRawTransaction", [raw])
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EIP-1193 params
  async request({ method, params = [] }: { method: string; params?: any[] }): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [this.signer.address]
      case "eth_chainId":
        return utils.hexValue(this.chainId)
      case "wallet_switchEthereumChain":
        if (this.noSwitch) throw { code: 4902, message: "Unrecognized chain ID" }
        this.chainId = Number(params[0].chainId)
        for (const listener of this.listeners.chainChanged || []) listener(params[0].chainId)
        return null
      case "eth_sendTransaction": {
        if (this.reject) throw { code: 4001, message: "User rejected the request." }
        if (this.fail) throw { code: -32603, message: this.fail }
        const hash = await this.signAndSend(this.tamper ? this.tamper(params[0]) : params[0])
        this.sent.push(hash)
        if (this.afterSend) await this.afterSend()
        return hash
      }
      default:
        return rpc(method, params)
    }
  }
}

const TOKEN = "f".repeat(64)
let server: Server | null = null
let base = ""

afterEach(async () => {
  const s = server
  server = null
  if (!s) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node 18.2+
  const anyServer = s as any
  if (typeof anyServer.closeAllConnections === "function") anyServer.closeAllConnections()
  await new Promise<void>((resolve) => s.close(() => resolve()))
})

// The page's server on a free port, and the API as the page's script calls it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- page.js is plain JavaScript
const startPage = async (): Promise<any> => {
  const session = new DisburseSession({ root: join(work, "files"), waitMs: 20 })
  const s = createDisburseServer(session, { token: TOKEN }).server
  server = s
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()))
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  return P.createApi({ fetch, base, token: TOKEN, origin: base })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = (api: any, wallet: FakeWallet, events: any = {}): any =>
  P.createController({ wallet, api, chainId: 100, payer: null, events, sleep: async () => undefined })

const ALL = ["submissions", "removals", "atq"]

describe("disburse page: paying", () => {
  it("pays a folder's three payouts with one Disburse, each transfer once, recorded in the ledger like send's", async () => {
    const SUB = [
      { recipient: evmAddress(0x201), amount: PNK(500) },
      { recipient: evmAddress(0x202), amount: PNK("1234.5") },
    ]
    const REM = [{ recipient: evmAddress(0x203), amount: PNK(7000) }]
    const ATQ = [{ recipient: evmAddress(0x201), amount: PNK(3000) }]
    writeFolder("october/combined", { submissions: SUB, removals: REM, atq: ATQ })
    writeFolder("october/filter on", { submissions: [SUB[0]] }, 1790000000011)
    const api = await startPage()
    const overview = await api.overview()
    assert.equal(overview.chainId, 100)
    assert.equal(overview.payer, null)
    assert.deepEqual(overview.folders.map((f: { id: string }) => f.id), ["october/combined", "october/filter on"])
    assert.deepEqual(
      overview.folders[0].payouts.map((p: { kind: string; transfers: number; status: string; period: string }) => [p.kind, p.transfers, p.status, p.period]),
      [
        ["submissions", 2, "not paid", "2026-09"],
        ["removals", 1, "not paid", "2026-09"],
        ["atq", 1, "not paid", "2026-09"],
      ]
    )

    const fake = new FakeWallet(wallet)
    const confirmed: string[] = []
    const controller = page(api, fake, { confirmed: (step: { kind: string; index: number }) => confirmed.push(`${step.kind}#${step.index}`) })
    const result = await controller.check("october/combined", ALL)
    assert.ok(result.checkId, JSON.stringify(result.problems))
    assert.equal(result.due, PNK("11734.5").toString())
    assert.deepEqual(
      result.payouts.map((p: { kind: string; toSend: number; refusal?: string }) => [p.kind, p.toSend, p.refusal]),
      [
        ["submissions", 2, undefined],
        ["removals", 1, undefined],
        ["atq", 1, undefined],
      ]
    )
    assert.ok(result.payouts[0].log.some((line: string) => /Paid from another wallet: none of these transfers/.test(line)))
    const done = await controller.disburse()
    assert.equal(done.state, "done")
    assert.deepEqual(confirmed, ["submissions#0", "submissions#1", "removals#0", "atq#0"])
    assert.deepEqual(
      paid().map((p) => [p.to, p.amount]),
      [...SUB, ...REM, ...ATQ].map((e) => [e.recipient, e.amount.toString()])
    )
    assert.equal(fake.sent.length, 4)
    const records = ledger()
    assert.deepEqual(records.map((r) => [r.kind, r.status, r.from]).sort(), [
      ["atq", "completed", wallet.address],
      ["removals", "completed", wallet.address],
      ["submissions", "completed", wallet.address],
    ])
    for (const r of records) {
      for (const t of r.transfers) {
        assert.equal(t.status, "confirmed")
        assert.equal(t.viaWallet, true)
        assert.ok(fake.sent.includes(String(t.txHash)))
        assert.equal(t.rawTx, undefined, "a browser wallet's transaction is never saved signed")
      }
    }
    assert.ok((await api.overview()).folders[0].payouts.every((p: { status: string }) => p.status === "disbursed"))
    assert.ok(records.every((r) => r.version === 2), "a record holding browser-wallet transfers is version 2")
    await assert.rejects(
      sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "october/combined") }, { log }),
      /this payout was already disbursed/,
      "send reads it, and refuses to pay it again"
    )

    // the same folder again: nothing to send
    const again = await controller.check("october/combined", ALL)
    assert.equal(again.checkId, null)
    assert.ok(again.payouts.every((p: { refusal?: string }) => /already disbursed/.test(String(p.refusal))))
    assert.equal(paid().length, 4)
  })

  it("leaves out, in send's own words, a payout send refuses: a month already paid, or paid from another wallet", async () => {
    const SUB = [{ recipient: evmAddress(0x301), amount: PNK(10) }]
    const REM = [{ recipient: evmAddress(0x302), amount: PNK(20) }]
    writeFolder("v1", { submissions: SUB })
    writeFolder("v2", { submissions: [{ recipient: evmAddress(0x301), amount: PNK(11) }], removals: REM }, 1790000000021)
    // v1's submissions paid with `--mode send`
    await sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "v1") }, { log })
    // v2's removals paid from another wallet, outside the ledger
    evm.addPastTransfer(Wallet.createRandom().address, REM[0].recipient, REM[0].amount)
    const api = await startPage()
    const result = await page(api, new FakeWallet(wallet)).check("v2", ["submissions", "removals"])
    assert.equal(result.checkId, null)
    assert.match(String(result.payouts[0].refusal), /Paying 1790000000021\.json too would pay that period twice/)
    assert.match(String(result.payouts[1].refusal), /1 of the 1 transfers to send were already received by their recipients since .*, from another wallet/)
    assert.ok(result.problems.some((p: string) => /submissions, removals cannot be paid .* untick them to pay the rest/.test(p)))
    assert.equal(paid().length, 1)

    // a payout refused stops the run even when another could be paid: paying only the rest is a choice
    writeFolder("v3", { removals: REM, atq: [{ recipient: evmAddress(0x303), amount: PNK(12) }] }, 1790000000031)
    const mixed = await page(api, new FakeWallet(wallet)).check("v3", ["removals", "atq"])
    assert.equal(mixed.checkId, null)
    assert.ok(mixed.problems.some((p: string) => /^removals cannot be paid/.test(p)), JSON.stringify(mixed.problems))
    const rest = await page(api, new FakeWallet(wallet)).check("v3", ["atq"])
    assert.ok(rest.checkId, "unticked, the rest can be paid")
  })

  it("pays only from the folders of files/ it lists, never a path the page makes up", async () => {
    writeFolder("ok", { submissions: [{ recipient: evmAddress(0x401), amount: PNK(1) }] })
    const api = await startPage()
    const account = wallet.address
    for (const folder of ["../..", "ok/..", "/etc", "nope", ""]) {
      await assert.rejects(api.check({ folder, kinds: ["submissions"], account }), /is not a folder of .* with payouts to disburse/)
    }
    await assert.rejects(api.check({ folder: "ok", kinds: ["removals"], account }), /ok has no removals payout/)
    await assert.rejects(api.check({ folder: "ok", kinds: [], account }), /Choose at least one payout/)
    await assert.rejects(api.check({ folder: "ok", kinds: ["submissions"], account: "0xnope" }), /is not an account/)
  })

  it("switches the wallet to the chain, and refuses another chain or, when SEND_FROM pins one, another account", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0x501), amount: PNK(1) }] })
    const api = await startPage()
    const onEthereum = new FakeWallet(wallet)
    onEthereum.chainId = 1
    assert.ok((await page(api, onEthereum).check("f", ["submissions"])).checkId)
    assert.equal(onEthereum.chainId, 100)
    const noGnosis = new FakeWallet(wallet)
    noGnosis.chainId = 1
    noGnosis.noSwitch = true
    await assert.rejects(page(api, noGnosis).check("f", ["submissions"]), /doesn't have chain 100/)

    const restore = setEnv({ SEND_FROM: evmAddress(0x999) })
    try {
      assert.equal((await api.overview()).payer, utils.getAddress(evmAddress(0x999)))
      await assert.rejects(api.check({ folder: "f", kinds: ["submissions"], account: wallet.address }), /not 0x0+999 \(SEND_FROM\)/)
      const pinned = P.createController({ wallet: new FakeWallet(wallet), api, chainId: 100, payer: evmAddress(0x999), sleep: async () => undefined })
      await assert.rejects(pinned.check("f", ["submissions"]), /\(SEND_FROM\): select it in the wallet/)
    } finally {
      restore()
    }
  })

  it("stops when the transfer is rejected in the wallet, nothing sent, and sends it after the next Check", async () => {
    const SUB = [
      { recipient: evmAddress(0x601), amount: PNK(5) },
      { recipient: evmAddress(0x602), amount: PNK(6) },
    ]
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const stopped: string[] = []
    const controller = page(api, fake, { stopped: (message: string) => stopped.push(message) })
    await controller.check("f", ["submissions"])
    fake.reject = true
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /Rejected in the wallet: nothing was sent/)
    assert.equal(paid().length, 0)
    assert.deepEqual(ledger()[0].transfers.map((t) => t.status), ["pending", "pending"])
    await assert.rejects(controller.disburse(), /Check first/, "a check is used once")
    fake.reject = false
    await controller.check("f", ["submissions"])
    assert.equal((await controller.disburse()).state, "done")
    assert.deepEqual(paid().map((p) => p.to), SUB.map((e) => e.recipient))
  })
})

describe("disburse page: what the check finds", () => {
  it("sets aside, or records as paid, the transfers the check finds on-chain, as the operator says", async () => {
    const SUB = [
      { recipient: evmAddress(0xe01), amount: PNK(5) },
      { recipient: evmAddress(0xe02), amount: PNK(6) },
    ]
    writeFolder("f", { submissions: SUB })
    const elsewhere = Wallet.createRandom().address
    const found = evm.addPastTransfer(elsewhere, SUB[0].recipient, SUB[0].amount)
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const refused = await page(api, fake).check("f", ["submissions"])
    assert.equal(refused.checkId, null)
    assert.match(String(refused.payouts[0].refusal), /1 of the 2 transfers to send were already received by their recipients .* from another wallet/)
    // it only coincides: set aside, everything is sent
    const aside = await page(api, fake).check("f", ["submissions"], { unrelatedTxs: [found] })
    assert.ok(aside.checkId, JSON.stringify(aside.problems))
    assert.equal(aside.payouts[0].toSend, 2)
    assert.equal(ledger().length, 0, "a check records nothing it was not told to")
    // it is this payout's payment: recorded as paid, and only the rest is sent
    const controller = page(api, fake)
    const recorded = await controller.check("f", ["submissions"], { skipPaidOnChain: true })
    assert.ok(recorded.checkId, JSON.stringify(recorded.problems))
    assert.equal(recorded.payouts[0].toSend, 1)
    assert.ok(recorded.notes.some((n: string) => /the transfers found on-chain are recorded as paid/.test(n)), JSON.stringify(recorded.notes))
    const t = ledger()[0].transfers[0]
    assert.equal(t.status, "confirmed")
    assert.equal(t.foundOnChain, true)
    assert.equal(String(t.paidBy).toLowerCase(), elsewhere.toLowerCase())
    assert.equal((await controller.disburse()).state, "done")
    assert.deepEqual(paid().map((p) => p.to), [SUB[1].recipient])
    assert.equal(ledger()[0].status, "completed")
  })

  it("records as disbursed, at the check, a payout found paid in full", async () => {
    const SUB = [{ recipient: evmAddress(0xe11), amount: PNK(5) }]
    writeFolder("f", { submissions: SUB })
    evm.addPastTransfer(Wallet.createRandom().address, SUB[0].recipient, SUB[0].amount)
    const api = await startPage()
    const result = await page(api, new FakeWallet(wallet)).check("f", ["submissions"], { skipPaidOnChain: true })
    assert.equal(result.checkId, null)
    assert.ok(result.notes.some((n: string) => /every transfer is paid: recorded as disbursed/.test(n)), JSON.stringify(result.notes))
    assert.equal(ledger()[0].status, "completed")
    assert.equal((await api.overview()).folders[0].payouts[0].status, "disbursed")
    assert.equal(paid().length, 0)
  })

  it("refuses a folder whose manifests name one file for two payouts: one file is one payout", async () => {
    const REM = [{ recipient: evmAddress(0xe31), amount: PNK(5) }]
    writeFolder("f", { removals: REM, atq: REM })
    const manifest = join(work, "files", "f", "latest_removals_manifest.json")
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = JSON.parse(require("fs").readFileSync(manifest, "utf8"))
    m.atqTransactionsFile = m.transactionsFile // edited by hand
    writeJson(manifest, m)
    const api = await startPage()
    const atq = (await api.overview()).folders[0].payouts.find((p: { kind: string }) => p.kind === "atq")
    assert.match(String(atq.problem), /the manifests name .* for removals too: one file is one payout/)
    const fake = new FakeWallet(wallet)
    const both = await page(api, fake).check("f", ["removals", "atq"])
    assert.equal(both.checkId, null)
    assert.match(String(both.payouts[1].refusal), /one file is one payout/)
    const controller = page(api, fake)
    assert.ok((await controller.check("f", ["removals"])).checkId)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 1)
  })

  it("refuses a payout with transfers yarn start --mode send signed and did not settle, which only send can finish", async () => {
    const SUB = [
      { recipient: evmAddress(0xe41), amount: PNK(5) },
      { recipient: evmAddress(0xe42), amount: PNK(6) },
    ]
    writeFolder("f", { submissions: SUB })
    evm.autoMine = false
    await assert.rejects(sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "f") }, { log }), /was not mined within/)
    const api = await startPage()
    const stuck = await api.check({ folder: "f", kinds: ["submissions"], account: wallet.address })
    assert.equal(stuck.checkId, null)
    assert.match(String(stuck.payouts[0].refusal), /1 transfer\(s\) of it were signed by yarn start --mode send and are not settled yet: stop this page/)
    evm.mine() // send's transaction, mined: the check records it, and the rest is the page's to pay
    evm.autoMine = true
    const controller = page(api, new FakeWallet(wallet))
    const result = await controller.check("f", ["submissions"])
    assert.ok(result.checkId, JSON.stringify(result.problems))
    assert.ok(result.notes.some((n: string) => /brought up to date from the chain/.test(n)), JSON.stringify(result.notes))
    assert.equal(result.payouts[0].toSend, 1)
    assert.equal((await controller.disburse()).state, "done")
    assert.deepEqual(paid().map((p) => p.to.toLowerCase()), SUB.map((e) => e.recipient.toLowerCase()))
  })

  it("lets another account's unsettled request stop only its own payout", async () => {
    writeFolder("a", { submissions: [{ recipient: evmAddress(0xe51), amount: PNK(5) }] })
    writeFolder("b", { removals: [{ recipient: evmAddress(0xe52), amount: PNK(6) }] }, 1790000000051)
    const api = await startPage()
    const other = Wallet.createRandom()
    evm.setTokenBalance(other.address, PNK(100))
    evm.setNativeBalance(other.address, utils.parseEther("1"))
    const first = await page(api, new FakeWallet(other)).check("a", ["submissions"])
    await api.next({ checkId: first.checkId }) // handed to the other account's wallet; no answer
    const controller = page(api, new FakeWallet(wallet))
    const result = await controller.check("b", ["removals"])
    assert.ok(result.checkId, JSON.stringify(result.problems) + JSON.stringify(result.payouts.map((p: { refusal?: string }) => p.refusal)))
    assert.ok(result.notes.some((n: string) => /handed to the wallet of 0x[0-9a-fA-F]{40}, not settled/.test(n)), JSON.stringify(result.notes))
    assert.deepEqual(result.unsettled[0].actions, [])
    assert.equal((await controller.disburse()).state, "done")
    const theirs = await page(api, new FakeWallet(wallet)).check("a", ["submissions"])
    assert.equal(theirs.checkId, null, "its own payout stays refused")
  })

  it("moves to the account paying now a payout started from another one that never sent any of it", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xe21), amount: PNK(5) }] })
    const api = await startPage()
    const first = await page(api, new FakeWallet(wallet)).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    assert.equal((await api.rejected({ requestId: step.requestId })).state, "cleared") // rejected in the wallet
    assert.equal(ledger()[0].from, wallet.address)
    const other = Wallet.createRandom()
    evm.setTokenBalance(other.address, PNK(100))
    evm.setNativeBalance(other.address, utils.parseEther("1"))
    const result = await page(api, new FakeWallet(other)).check("f", ["submissions"])
    assert.ok(result.notes.some((n: string) => n.includes(`started from ${wallet.address}, which never sent any of it`)), JSON.stringify(result.notes))
    assert.equal(ledger()[0].from, other.address)
    assert.ok(result.checkId, JSON.stringify(result.problems))
  })
})

describe("disburse page: answers lost, and transactions replaced", () => {
  it("settles from the chain a transfer the wallet sent while the page lost its answer, never sending it twice", async () => {
    const SUB = [
      { recipient: evmAddress(0x701), amount: PNK(5) },
      { recipient: evmAddress(0x702), amount: PNK(6) },
    ]
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    assert.equal(ledger()[0].transfers[0].status, "requested", "recorded before the wallet is asked")
    await fake.request({ method: "eth_sendTransaction", params: [step.tx] }) // sent; the page closed before hearing it

    const reloaded = page(api, fake)
    const second = await reloaded.check("f", ["submissions"])
    assert.ok(second.notes.some((n: string) => /the wallet sent it, 0x[0-9a-f]{64}, mined in block/.test(n)), JSON.stringify(second.notes))
    assert.deepEqual(second.payouts[0].transfers.map((t: { status: string }) => t.status), ["confirmed", "pending"])
    assert.equal((await reloaded.disburse()).state, "done")
    assert.deepEqual(paid().map((p) => p.to), SUB.map((e) => e.recipient))
  })

  it("leaves to the operator a transfer handed out with no answer, marked never sent only while the chain agrees", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0x801), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId }) // handed out; the page closed before the wallet answered
    const second = await page(api, fake).check("f", ["submissions"])
    assert.equal(second.checkId, null)
    assert.equal(second.unsettled.length, 1)
    assert.match(second.unsettled[0].why, /the account has sent nothing since\. If the wallet still shows that request, reject it there/)
    assert.match(String(second.payouts[0].refusal), /Settle the transfers handed to a wallet before/)

    // the wallet's request, approved late: never marked as never sent
    await fake.request({ method: "eth_sendTransaction", params: [step.tx] })
    await assert.rejects(api.forget({ recordId: second.unsettled[0].recordId, index: 0 }), /Not forgetting it: 0x[0-9a-f]{64} \(block \d+\) pays/)
    const third = page(api, fake)
    const settled = await third.check("f", ["submissions"])
    assert.equal(settled.payouts[0].transfers[0].status, "confirmed")
    assert.equal(paid().length, 1)
  })

  it("sends again, once the operator marks it never sent, a transfer the wallet was never asked for", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0x811), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    await api.next({ checkId: first.checkId })
    const second = await page(api, fake).check("f", ["submissions"])
    assert.equal((await api.forget({ recordId: second.unsettled[0].recordId, index: 0 })).state, "cleared")
    const controller = page(api, fake)
    assert.ok((await controller.check("f", ["submissions"])).checkId)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 1)
  })

  it("never takes for the transfer's payment a wallet transaction that is not exactly it", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0x901), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    fake.tamper = (tx) => ({ ...tx, data: P.transferData(evmAddress(0x902), PNK(5).toString()) })
    const stopped: string[] = []
    const controller = page(api, fake, { stopped: (message: string) => stopped.push(message) })
    await controller.check("f", ["submissions"])
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /is not the transfer it was asked for: its data is not transfer\(recipient, amount\)/)
    const t = ledger()[0].transfers[0]
    assert.equal(t.status, "requested")
    assert.equal(t.txHash, undefined)
    assert.equal(String(t.reportedTxHash), fake.sent[0].toLowerCase(), "the wallet's answer is kept")
    // the next check leaves it to the operator: that transaction is mined, is not the transfer, and nothing pays it
    const again = await page(api, fake).check("f", ["submissions"])
    assert.equal(again.unsettled.length, 1)
    assert.match(again.unsettled[0].why, /which is not this transfer \(its data is not transfer\(recipient, amount\) of this transfer\), and nothing pays the transfer/)
    assert.deepEqual(again.unsettled[0].actions, ["hash", "forget"])
    await assert.rejects(api.recordHash({ recordId: again.unsettled[0].recordId, index: 0, hash: fake.sent[0] }), /is not this transfer: its data/)
    assert.equal((await api.forget({ recordId: again.unsettled[0].recordId, index: 0 })).state, "cleared")
    const cleared = ledger()[0].transfers[0]
    assert.equal(cleared.status, "pending")
    assert.deepEqual(cleared.strayTxs, [fake.sent[0].toLowerCase()], "kept as evidence")
    assert.equal(cleared.forgottenTxs, undefined)
  })

  it("follows the wallet's replacements: sped up, the replacement pays it; cancelled, the operator says it was never sent", async () => {
    writeFolder("f", {
      submissions: [
        { recipient: evmAddress(0xa01), amount: PNK(5) },
        { recipient: evmAddress(0xa02), amount: PNK(6) },
      ],
    })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    evm.autoMine = false
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const hash = await fake.request({ method: "eth_sendTransaction", params: [step.tx] })
    assert.equal((await api.sent({ requestId: step.requestId, hash })).state, "sent")
    assert.equal((await api.receipt({ requestId: step.requestId })).state, "pending")
    const nonce = ledger()[0].transfers[0].nonce as number
    const faster = await fake.signAndSend(step.tx, { max: "4", tip: "2" }, nonce) // sped up in the wallet
    evm.mine()
    const sped = await api.receipt({ requestId: step.requestId })
    assert.equal(sped.state, "confirmed")
    assert.equal(sped.hash, faster)
    assert.match(sped.note, /the wallet's replacement of 0x[0-9a-f]{64} \(sped up\)/)

    // the second, cancelled in the wallet: a transaction to itself with its nonce
    const next = await api.next({ checkId: first.checkId })
    const second = await fake.request({ method: "eth_sendTransaction", params: [next.tx] })
    assert.equal((await api.sent({ requestId: next.requestId, hash: second })).state, "sent")
    await fake.signAndSend({ to: wallet.address, data: "0x" }, { max: "4", tip: "2" }, nonce + 1)
    evm.mine()
    const cancelled = await api.receipt({ requestId: next.requestId })
    assert.equal(cancelled.state, "stopped")
    assert.match(cancelled.message, /nothing pays the transfer \(cancelled in the wallet\?\)/)
    assert.equal(ledger()[0].transfers[1].status, "sent", "never forgotten on its own")
    const after = await page(api, fake).check("f", ["submissions"])
    assert.equal(after.checkId, null)
    assert.equal(after.unsettled.length, 1)
    assert.deepEqual(after.unsettled[0].actions, ["hash", "forget"])
    assert.equal((await api.forget({ recordId: after.unsettled[0].recordId, index: 1 })).state, "cleared")
    const t = ledger()[0].transfers[1]
    assert.equal(t.status, "pending")
    assert.deepEqual(t.forgottenTxs, [second])
    evm.autoMine = true
    const resend = page(api, fake)
    assert.ok((await resend.check("f", ["submissions"])).checkId)
    assert.equal((await resend.disburse()).state, "done")
    assert.deepEqual(paid().map((p) => p.hash).slice(0, 1), [faster])
    assert.equal(paid().length, 2)
  })

  it("waits out a receipt the node serves late, never taking the transfer for replaced", async () => {
    writeFolder("f", {
      submissions: [
        { recipient: evmAddress(0xa11), amount: PNK(5) },
        { recipient: evmAddress(0xa12), amount: PNK(6) },
      ],
    })
    const api = await startPage()
    evm.faults.receiptLag = 8 // longer than the session polls a receipt before reading the Transfer logs
    const controller = page(api, new FakeWallet(wallet))
    await controller.check("f", ["submissions"])
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 2)
    for (const t of ledger()[0].transfers) {
      assert.equal(t.status, "confirmed")
      assert.equal(t.forgottenTxs, undefined)
    }
  })

  it("keeps every hash the wallet answers, and marks a transfer never sent only when the chain cannot contradict it", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa21), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const ghost = `0x${"ab".repeat(32)}` // what the wallet answered, which no node ever saw
    assert.equal((await api.sent({ requestId: step.requestId, hash: ghost })).state, "unverified")
    assert.equal(ledger()[0].transfers[0].reportedTxHash, ghost)
    const second = await page(api, fake).check("f", ["submissions"])
    assert.equal(second.unsettled.length, 1)
    assert.deepEqual(second.unsettled[0].actions, ["hash"])
    await assert.rejects(
      api.forget({ recordId: second.unsettled[0].recordId, index: 0 }),
      /which the RPC does not know, and the account has sent nothing since: it may still be sent/
    )
    // the account moves on, and nothing pays the transfer: now it may be marked never sent
    await fake.signAndSend({ to: evmAddress(0xbad), data: "0x" })
    const third = await page(api, fake).check("f", ["submissions"])
    assert.deepEqual(third.unsettled[0].actions, ["hash", "forget"])
    assert.equal((await api.forget({ recordId: third.unsettled[0].recordId, index: 0 })).state, "cleared")
    assert.deepEqual(ledger()[0].transfers[0].forgottenTxs, [ghost])
    const controller = page(api, fake)
    assert.ok((await controller.check("f", ["submissions"])).checkId)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 1)
  })

  it("records a wallet's answer that comes after the page checked again, and flags a second payment", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa31), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const hash = await fake.request({ method: "eth_sendTransaction", params: [step.tx] })
    // another tab, or the page reloaded, checks before the answer is reported
    const second = await page(api, fake).check("f", ["submissions"])
    assert.equal(second.payouts[0].transfers[0].status, "confirmed")
    assert.equal(ledger()[0].status, "completed", "a payout found paid in full at a check is recorded as disbursed")
    await assert.rejects(api.sent({ requestId: step.requestId, hash }), /settled the transfer from the chain \(confirmed, by this very transaction\)/)
    // the same request approved a second time: kept on the transfer, and flagged
    const twice = await fake.signAndSend(step.tx)
    await assert.rejects(api.sent({ requestId: step.requestId, hash: twice }), /late, after that transfer was settled \(confirmed\)\. It is recorded.*paid twice/s)
    assert.deepEqual(ledger()[0].transfers[0].strayTxs, [String(twice).toLowerCase()])
    const flagged = await page(api, fake).check("f", ["submissions"])
    assert.ok(flagged.problems.some((p: string) => new RegExp(`was paid again by ${twice}.*the recipient was paid twice`).test(p)), JSON.stringify(flagged.problems))
    assert.deepEqual(ledger()[0].transfers[0].paidTwiceBy, [String(twice).toLowerCase()])
    const after = await page(api, fake).check("f", ["submissions"])
    assert.ok(!after.problems.some((p: string) => /paid again/.test(p)), "said once, and recorded")
  })

  it("never takes a late answer for a newer hand-out of the same transfer", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa35), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const old = await api.next({ checkId: first.checkId }) // its popup stays open; the page reloads
    const second = await page(api, fake).check("f", ["submissions"])
    assert.equal((await api.forget({ recordId: second.unsettled[0].recordId, index: 0 })).state, "cleared")
    const third = await page(api, fake).check("f", ["submissions"])
    const fresh = await api.next({ checkId: third.checkId }) // handed out again, with the same nonce
    const late = await fake.request({ method: "eth_sendTransaction", params: [old.tx] }) // the old popup, approved
    await assert.rejects(api.sent({ requestId: old.requestId, hash: late }), /for an earlier hand-out of it .*it is recorded on it/s)
    let t = ledger()[0].transfers[0]
    assert.equal(t.status, "requested")
    assert.equal(t.reportedTxHash, undefined, "not taken for the newer hand-out's answer")
    assert.deepEqual(t.strayTxs, [String(late).toLowerCase()])
    // the newer one, approved too: it comes after the late one, so the run stops at once; both are recorded,
    // and the next check says the transfer was paid twice
    const again = await fake.request({ method: "eth_sendTransaction", params: [fresh.tx] })
    await assert.rejects(
      api.sent({ requestId: fresh.requestId, hash: again }),
      /with nonce 1, while the account's next nonce was 0: 0x[0-9a-fA-F]{40} sent 1 other transaction\(s\) since it was handed to the wallet/
    )
    const flagged = await page(api, fake).check("f", ["submissions"])
    t = ledger()[0].transfers[0]
    assert.equal(t.status, "confirmed")
    assert.equal(paid().length, 2)
    assert.ok(flagged.problems.some((p: string) => /was paid again by .*the recipient was paid twice/.test(p)), JSON.stringify(flagged.problems))
  })

  it("keeps the wallet's answer when the operator gives another hash, taken only once mined", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa37), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const ghost = `0x${"cd".repeat(32)}`
    await api.sent({ requestId: step.requestId, hash: ghost }) // what the wallet answered; no node knows it
    const listed = await page(api, fake).check("f", ["submissions"])
    const { recordId } = listed.unsettled[0]
    evm.autoMine = false
    const real = await fake.signAndSend(step.tx) // what the wallet's activity shows
    await assert.rejects(api.recordHash({ recordId, index: 0, hash: real }), /which the RPC does not know: 0x[0-9a-f]{64} is taken for it once mined/)
    evm.mine()
    assert.match((await api.recordHash({ recordId, index: 0, hash: real })).message, /Recorded 0x[0-9a-f]{64} as the transfer's transaction \(confirmed\)/)
    const t = ledger()[0].transfers[0]
    assert.equal(t.status, "confirmed")
    assert.equal(t.txHash, String(real).toLowerCase())
    assert.deepEqual(t.strayTxs, [ghost], "the wallet's answer is kept")
  })

  it("marks as never sent a wallet transaction the node dropped only once its nonce is used", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa41), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    evm.autoMine = false
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const hash = await fake.request({ method: "eth_sendTransaction", params: [step.tx] })
    assert.equal((await api.sent({ requestId: step.requestId, hash })).state, "sent")
    // the page itself does not even check while the wallet's node shows it pending
    await assert.rejects(page(api, fake).check("f", ["submissions"]), /The wallet's node shows 1 transaction\(s\) of .* pending/)
    const waiting = await api.check({ folder: "f", kinds: ["submissions"], account: wallet.address })
    assert.match(waiting.unsettled[0].why, /is not mined yet: wait for it/)
    assert.deepEqual(waiting.unsettled[0].actions, [], "pending: nothing to decide")
    await assert.rejects(api.forget({ recordId: waiting.unsettled[0].recordId, index: 0 }), /has a transaction pending/)
    evm.dropMempool()
    const dropped = await page(api, fake).check("f", ["submissions"])
    assert.match(dropped.unsettled[0].why, /the RPC no longer knows it \(dropped\?\), but its nonce 0 is free, so it may still be sent/)
    assert.deepEqual(dropped.unsettled[0].actions, ["hash"])
    // the wallet, or another node, may still send it: refused while its nonce is free
    await assert.rejects(api.forget({ recordId: dropped.unsettled[0].recordId, index: 0 }), /nonce 0 is still free: a node, or the wallet, may still send it/)
    evm.autoMine = true
    await fake.signAndSend({ to: wallet.address, data: "0x" }, { max: "4", tip: "2" }, 0) // nonce 0 used: a 0-value transaction to itself
    const used = await page(api, fake).check("f", ["submissions"])
    assert.match(used.unsettled[0].why, /can no longer be mined: its nonce went to another transaction, and nothing pays the transfer/)
    assert.deepEqual(used.unsettled[0].actions, ["hash", "forget"])
    assert.equal((await api.forget({ recordId: used.unsettled[0].recordId, index: 0 })).state, "cleared")
    assert.deepEqual(ledger()[0].transfers[0].forgottenTxs, [String(hash).toLowerCase()])
    const controller = page(api, fake)
    assert.ok((await controller.check("f", ["submissions"])).checkId)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 1)
  })

  it("stops when the account sends anything else between two transfers: what the check saw no longer holds", async () => {
    writeFolder("f", {
      submissions: [
        { recipient: evmAddress(0xb01), amount: PNK(5) },
        { recipient: evmAddress(0xb02), amount: PNK(6) },
      ],
    })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    let stray = true
    fake.afterSend = async () => {
      if (!stray) return
      stray = false
      await fake.signAndSend({ to: evmAddress(0xbad), data: "0x" }) // another app, the same account
    }
    const stopped: string[] = []
    const controller = page(api, fake, { stopped: (message: string) => stopped.push(message) })
    await controller.check("f", ["submissions"])
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /has sent or is sending a transaction this page did not/)
    assert.equal(paid().length, 1)
  })
})

describe("disburse page: its server", () => {
  it("answers only the page, on this machine, and serves only its own files", async () => {
    await startPage()
    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.equal(home.headers.get("x-frame-options"), "DENY")
    assert.match(String(home.headers.get("content-security-policy")), /frame-ancestors 'none'/)
    assert.ok(!(await home.text()).includes(TOKEN), "the page carries no secret: the key is in the link's #, which no request carries")
    for (const path of ["/page.js", "/main.js", "/style.css"]) assert.equal((await fetch(base + path)).status, 200)
    assert.equal((await fetch(`${base}/api/overview`)).status, 404, "the API is POST only")
    assert.equal((await fetch(`${base}/session.ts`)).status, 404)

    const post = (headers: { [key: string]: string }) => fetch(`${base}/api/overview`, { method: "POST", headers, body: "{}" })
    const good = { "Content-Type": "application/json", "X-Disburse-Session": TOKEN, Origin: base }
    assert.equal((await post(good)).status, 200)
    assert.equal((await post({ ...good, "X-Disburse-Session": "0".repeat(64) })).status, 403, "another session token")
    assert.equal((await post({ "Content-Type": "application/json", Origin: base })).status, 403, "no token")
    assert.equal((await post({ ...good, Origin: "https://evil.example" })).status, 403, "another site")
    assert.equal((await post({ ...good, "Content-Type": "text/plain" })).status, 415, "a form's content type")

    const { hostname, port, host } = new URL(base)
    const raw = (path: string, hostHeader: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: hostname, port, path, method: "GET", headers: { Host: hostHeader } }, (res) => {
          res.resume()
          resolve(res.statusCode || 0)
        })
        req.on("error", reject)
        req.end()
      })
    assert.equal(await raw("/", "evil.example"), 404, "DNS rebinding")
    assert.equal(await raw("/", `evil.example:${port}`), 404)
    assert.equal(await raw("/", `localhost:${port}`), 200)
    assert.equal(await raw("/../package.json", host), 404)
    assert.equal(await raw("/%2e%2e/package.json", host), 404)
  })
})

describe("disburse page and send: one ledger", () => {
  it("send lists, in one refusal, what this wallet and other wallets already paid", async () => {
    const SUB = [
      { recipient: evmAddress(0xc21), amount: PNK(5) },
      { recipient: evmAddress(0xc22), amount: PNK(6) },
      { recipient: evmAddress(0xc23), amount: PNK(7) },
    ]
    writeFolder("f", { submissions: SUB })
    evm.addPastTransfer(wallet.address, SUB[0].recipient, SUB[0].amount)
    evm.addPastTransfer(Wallet.createRandom().address, SUB[1].recipient, SUB[1].amount)
    await assert.rejects(
      sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "f"), dryRun: true }, { log }),
      /1 of the 3 transfers to send repeat transfers this wallet already paid.*\nAnd 1 of the 3 transfers to send were already received by their recipients since .*, from another wallet.*from this wallet and from another account/s
    )
  })

  it("send refuses a payout with a transfer handed to a browser wallet and not settled", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xc01), amount: PNK(5) }] })
    const api = await startPage()
    const first = await page(api, new FakeWallet(wallet)).check("f", ["submissions"])
    await api.next({ checkId: first.checkId })
    await assert.rejects(
      sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "f") }, { log }),
      /was handed to a browser wallet by the disburse page/
    )
    assert.equal(paid().length, 0)
  })

  it("send waits for a transfer a browser wallet sent, never rebroadcasting or signing it anew", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xc11), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    evm.autoMine = false
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const hash = await fake.request({ method: "eth_sendTransaction", params: [step.tx] })
    await api.sent({ requestId: step.requestId, hash })
    const opts = { file: "1790000000001.json", filesDir: join(work, "files", "f") }
    await assert.rejects(sendRoutine(opts, { log }), /was sent from a browser wallet and is not mined yet/)
    evm.mine()
    await sendRoutine(opts, { log })
    assert.equal(ledger()[0].status, "completed")
    assert.deepEqual(paid().map((p) => p.hash), [hash])
  })
})
