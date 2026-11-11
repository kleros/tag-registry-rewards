import { afterEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber, utils, Wallet } from "ethers"
import { existsSync } from "fs"
import { request as httpRequest, Server } from "http"
import { AddressInfo, connect, createServer as createTcpServer } from "net"
import { join } from "path"
import { disbursePageRoutine } from "../../src/disburse/routine"
import { createDisburseServer } from "../../src/disburse/server"
import { DisburseSession, SessionDeps } from "../../src/disburse/session"
import { sendRoutine } from "../../src/send-routine"
import { approveCalldata, createSendChain, DISPERSE_ADDRESS, disperseCalldata } from "../../src/utils/send-chain"
import { setEnv } from "../support/env"
import { writeJson } from "../support/files"
import { evmAddress } from "../support/fixtures"
import { acquireDisbursementLock, DisbursementRecord, disbursementsDir, saveDisbursement } from "../../src/utils/disbursement-ledger"
import { DISPERSE } from "../support/evm"
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
  rejectIf: ((tx: Tx) => boolean) | null = null
  fail: string | null = null
  noSwitch = false
  tamper: ((tx: Tx) => Tx) | null = null
  afterSend: (() => Promise<void>) | null = null
  connected = true // false: a wallet this page is not connected to yet
  shown: string | null = null // the account selected in it, when not the key's
  onRequest: ((method: string) => void) | null = null
  private listeners: { [event: string]: ((value: unknown) => void)[] } = {}

  constructor(readonly signer: Wallet) {}

  on(event: string, listener: (value: unknown) => void): void {
    this.listeners[event] = (this.listeners[event] || []).concat(listener)
  }

  // What a wallet tells the page when its account or chain changes.
  announce(event: "accountsChanged" | "chainChanged", value: unknown): void {
    for (const listener of this.listeners[event] || []) listener(value)
  }

  // The operator selects another account, or another chain, in the wallet.
  select(account: string): void {
    this.shown = account
    this.announce("accountsChanged", [account])
  }

  switchChain(chainId: number): void {
    this.chainId = chainId
    this.announce("chainChanged", utils.hexValue(chainId))
  }

  private account(): string {
    return this.shown || this.signer.address
  }

  async signAndSend(tx: Tx, fees = { max: "2", tip: "1" }, nonce?: number): Promise<string> {
    const n = nonce === undefined ? Number(await rpc("eth_getTransactionCount", [this.signer.address, "pending"])) : nonce
    // as a wallet does: the node's estimate, with a margin (a call that would
    // revert is let through with a generous limit, as a wallet lets one insist)
    let gasLimit = 1000000
    try {
      gasLimit = Math.ceil(Number(await rpc("eth_estimateGas", [{ from: this.signer.address, to: tx.to, data: tx.data, value: "0x0" }])) * 1.1)
    } catch {
      // would revert
    }
    const raw = await this.signer.signTransaction({
      type: 2,
      chainId: this.chainId,
      nonce: n,
      to: tx.to,
      data: tx.data,
      value: tx.value || 0,
      gasLimit,
      maxFeePerGas: utils.parseUnits(fees.max, "gwei"),
      maxPriorityFeePerGas: utils.parseUnits(fees.tip, "gwei"),
    })
    return rpc("eth_sendRawTransaction", [raw])
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EIP-1193 params
  async request({ method, params = [] }: { method: string; params?: any[] }): Promise<unknown> {
    if (this.onRequest) this.onRequest(method)
    switch (method) {
      case "eth_requestAccounts":
        if (!this.connected) {
          // approving the connection announces the account, as MetaMask and Rabby do
          this.connected = true
          this.announce("accountsChanged", [this.account()])
        }
        return [this.account()]
      case "eth_accounts":
        return this.connected ? [this.account()] : []
      case "eth_chainId":
        return utils.hexValue(this.chainId)
      case "wallet_switchEthereumChain":
        if (this.noSwitch) throw { code: 4902, message: "Unrecognized chain ID" }
        this.switchChain(Number(params[0].chainId))
        return null
      case "eth_sendTransaction": {
        if (this.reject || (this.rejectIf && this.rejectIf(params[0]))) throw { code: 4001, message: "User rejected the request." }
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
const servers: Server[] = []
let base = ""

afterEach(async () => {
  for (const s of servers.splice(0)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node 18.2+
    const anyServer = s as any
    if (typeof anyServer.closeAllConnections === "function") anyServer.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

// The page's server on a free port, and the API as the page's script calls it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- page.js is plain JavaScript
const startPage = async (deps: SessionDeps = {}): Promise<any> => {
  const session = new DisburseSession({ root: join(work, "files"), waitMs: 20, ...deps })
  const s = createDisburseServer(session, { token: TOKEN }).server
  servers.push(s)
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()))
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  return P.createApi({ fetch, base, token: TOKEN, origin: base })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = (api: any, wallet: FakeWallet, events: any = {}): any =>
  P.createController({ wallet, api, chainId: 100, payer: null, disperse: DISPERSE_ADDRESS, events, sleep: async () => undefined })

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

describe("disburse page: the wallet's account and chain", () => {
  const SUB = [
    { recipient: evmAddress(0xd01), amount: PNK(5) },
    { recipient: evmAddress(0xd02), amount: PNK(6) },
  ]
  const OTHER = evmAddress(0xd99)
  const DURING = /The wallet's account or chain changed during the check: Check again/

  it("checks at the first Check a wallet that announces its account as the page connects to it", async () => {
    writeFolder("f", { submissions: SUB })
    const fake = new FakeWallet(wallet)
    fake.connected = false
    fake.chainId = 1 // and it is switched to the chain, which it announces too
    const controller = page(await startPage(), fake)
    assert.ok((await controller.check("f", ["submissions"])).checkId)
    assert.equal(controller.canDisburse(), true)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 2)
  })

  it("throws away a check the wallet left meanwhile, for another account or chain", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    // while the server checks: told by the wallet, not told, or there and back
    const leaves: [string, (fake: FakeWallet) => void][] = [
      ["another account", (fake) => fake.select(OTHER)],
      ["another chain", (fake) => fake.switchChain(1)],
      ["another account, untold", (fake) => (fake.shown = OTHER)],
      ["another chain, untold", (fake) => (fake.chainId = 1)],
      ["another account and back", (fake) => (fake.select(OTHER), fake.select(wallet.address))],
    ]
    for (const [what, leave] of leaves) {
      const fake = new FakeWallet(wallet)
      const leaving = {
        ...api,
        check: async (body: unknown) => {
          const result = await api.check(body)
          leave(fake)
          return result
        },
      }
      const controller = page(leaving, fake)
      await assert.rejects(controller.check("f", ["submissions"]), DURING, what)
      assert.equal(controller.canDisburse(), false, what)
      await assert.rejects(controller.disburse(), /Check first/, what)
    }
    // while the wallet is made ready, after it gave its account
    const fake = new FakeWallet(wallet)
    fake.onRequest = (method) => {
      if (method === "eth_getTransactionCount" && !fake.shown) fake.select(OTHER)
    }
    const controller = page(api, fake)
    await assert.rejects(controller.check("f", ["submissions"]), DURING)
    assert.equal(controller.canDisburse(), false)
    // back on the account, it is checked
    fake.onRequest = null
    fake.select(wallet.address)
    assert.ok((await controller.check("f", ["submissions"])).checkId)
    assert.equal(paid().length, 0)
  })

  it("voids a check when the wallet's account or chain changes after it, and stops a run after the transfer with the wallet", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const voided: string[] = []
    const stopped: string[] = []
    const controller = page(api, fake, { voided: (event: string) => voided.push(event), stopped: (m: string) => stopped.push(m) })
    await controller.check("f", ["submissions"])
    fake.select(OTHER)
    assert.deepEqual(voided, ["accountsChanged"])
    assert.equal(controller.canDisburse(), false)
    await assert.rejects(controller.disburse(), /Check first/)
    fake.select(wallet.address)

    await controller.check("f", ["submissions"])
    fake.switchChain(1)
    assert.deepEqual(voided, ["accountsChanged", "chainChanged"])
    await assert.rejects(controller.disburse(), /Check first/)

    // in the middle of a run: the transfer with the wallet is followed to its
    // receipt, and the next one is not handed out
    await controller.check("f", ["submissions"]) // switches the wallet back to the chain
    assert.equal(fake.chainId, 100)
    fake.afterSend = async () => fake.select(OTHER)
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /Stopped after this one: Check again/)
    assert.equal(paid().length, 1)
    assert.deepEqual(ledger()[0].transfers.map((t) => t.status), ["confirmed", "pending"])

    fake.afterSend = null
    fake.select(wallet.address)
    await controller.check("f", ["submissions"])
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(paid().length, 2)
  })
})

describe("disburse page: one Disperse transaction", () => {
  const SUB = [
    { recipient: evmAddress(0xf01), amount: PNK(500) },
    { recipient: evmAddress(0xf02), amount: PNK("1234.5") },
  ]
  const REM = [{ recipient: evmAddress(0xf03), amount: PNK(7000) }]
  const ATQ = [{ recipient: evmAddress(0xf01), amount: PNK(3000) }]
  const ALL_ROWS = [...SUB, ...REM, ...ATQ]
  const TOTAL = ALL_ROWS.reduce((sum, e) => sum.add(e.amount), BigNumber.from(0))

  it("builds in the page the very calldata the server builds", () => {
    const rows = [
      { recipient: evmAddress(0xabc), amount: "6999999999999999999992" },
      { recipient: utils.getAddress(evmAddress(0xdef)), amount: "1" },
      { recipient: evmAddress(0xabc), amount: PNK(500).toString() },
    ]
    assert.equal(
      P.disperseData(evm.token, rows.map((r) => r.recipient), rows.map((r) => r.amount)),
      disperseCalldata(evm.token, rows).toLowerCase()
    )
    assert.equal(P.disperseData(evm.token, [], []), disperseCalldata(evm.token, []).toLowerCase())
    assert.equal(P.approveData(DISPERSE_ADDRESS, TOTAL.toString()), approveCalldata(DISPERSE_ADDRESS, TOTAL).toLowerCase())
  })

  it("pays a folder's three payouts in two confirmations: the exact total approved, then one batch", async () => {
    writeFolder("october/combined", { submissions: SUB, removals: REM, atq: ATQ })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const asked: string[] = []
    const controller = page(api, fake, { asking: (step: { state: string }) => asked.push(step.state) })
    const result = await controller.check("october/combined", ALL, { mode: "disperse" })
    assert.ok(result.checkId, JSON.stringify(result.problems))
    assert.equal(result.mode, "disperse")
    assert.deepEqual(result.disperse, { address: DISPERSE_ADDRESS, allowance: "0", confirmations: 2 })
    assert.ok(result.notes.some((n: string) => /Two confirmations: approve Disperse .* for exactly 11,734\.5 PNK, then pay all 4 transfers/.test(n)), JSON.stringify(result.notes))
    assert.equal((await controller.disburse()).state, "done")
    assert.deepEqual(asked, ["approve", "disperse"])
    assert.equal(fake.sent.length, 2, "two confirmations")
    assert.deepEqual(
      paid().map((p) => [p.to.toLowerCase(), p.amount]),
      ALL_ROWS.map((e) => [e.recipient.toLowerCase(), e.amount.toString()])
    )
    assert.ok(paid().every((p) => p.hash === fake.sent[1]), "every transfer in the one batch transaction")
    assert.equal(evm.allowance(wallet.address, DISPERSE), BigInt(0), "nothing stays approved")
    const records = ledger()
    assert.deepEqual(records.map((r) => r.status), ["completed", "completed", "completed"])
    const transfers = records.flatMap((r) => r.transfers)
    for (const t of transfers) {
      assert.equal(t.status, "confirmed")
      assert.equal(t.txHash, fake.sent[1].toLowerCase())
      assert.equal(t.batch, 4)
      assert.equal(t.viaWallet, true)
    }
    assert.deepEqual(transfers.map((t) => t.batchIndex).sort(), [0, 1, 2, 3])
    const again = await page(api, fake).check("october/combined", ALL, { mode: "disperse" })
    assert.equal(again.checkId, null)
    assert.ok(again.payouts.every((p: { refusal?: string }) => /already disbursed/.test(String(p.refusal))))
    assert.ok(!again.problems.some((p: string) => /paid again/.test(p)), "one batch is not a second payment of its own transfers")
  })

  it("asks for one confirmation when Disperse is already allowed exactly the total, and re-approves any other amount", async () => {
    writeFolder("f", { submissions: SUB })
    evm.setAllowance(wallet.address, DISPERSE, PNK("1734.5"))
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const controller = page(api, fake)
    const result = await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(result.disperse.confirmations, 1)
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(fake.sent.length, 1)
    assert.deepEqual(paid().map((p) => p.to.toLowerCase()), SUB.map((e) => e.recipient.toLowerCase()))
    assert.equal(evm.allowance(wallet.address, DISPERSE), BigInt(0))

    // more than the total allowed (a spending cap raised in the wallet): set to exactly the total first, so
    // that no other batch, a request still open in the wallet, could spend anything after this one
    writeFolder("g", { removals: REM }, 1790000000061)
    evm.setAllowance(wallet.address, DISPERSE, PNK(100000))
    const again = page(api, fake)
    const second = await again.check("g", ["removals"], { mode: "disperse" })
    assert.equal(second.disperse.confirmations, 2)
    assert.ok(second.notes.some((n: string) => /approve Disperse .* for exactly 7,000 PNK \(it is allowed 100,000 PNK now\)/.test(n)), JSON.stringify(second.notes))
    assert.equal((await again.disburse()).state, "done")
    assert.equal(fake.sent.length, 3)
    assert.equal(evm.allowance(wallet.address, DISPERSE), BigInt(0), "nothing left allowed")
  })

  it("names the amount to approve to the last wei, as the wallet shows it", async () => {
    const exact = "331421.861696305094283609"
    writeFolder("f", { submissions: [{ recipient: evmAddress(0x3f1), amount: PNK(exact) }] })
    const api = await startPage()
    const result = await page(api, new FakeWallet(wallet)).check("f", ["submissions"], { mode: "disperse" })
    assert.ok(result.checkId, JSON.stringify(result.problems))
    assert.ok(result.notes.some((n: string) => n.includes("for exactly 331,421.861696305094283609 PNK, then pay")), JSON.stringify(result.notes))
    assert.equal(P.formatPnkExact(result.due), "331,421.861696305094283609")
    // and tells apart a balance one wei short of it
    evm.setTokenBalance(wallet.address, PNK(exact).sub(1))
    const short = await api.check({ folder: "f", kinds: ["submissions"], account: wallet.address, mode: "disperse" })
    assert.ok(
      short.problems.some((p: string) => p.includes("holds 331,421.861696305094283608 PNK, less than the 331,421.861696305094283609 PNK to send")),
      JSON.stringify(short.problems)
    )
  })

  it("leaves every transfer to send when the batch is rejected in the wallet, and pays it all after the next Check", async () => {
    writeFolder("f", { submissions: SUB, removals: REM })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    fake.rejectIf = (tx) => tx.to.toLowerCase() === DISPERSE
    const stopped: string[] = []
    const controller = page(api, fake, { stopped: (m: string) => stopped.push(m) })
    await controller.check("f", ["submissions", "removals"], { mode: "disperse" })
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /Rejected in the wallet: nothing was sent/)
    assert.equal(paid().length, 0)
    assert.ok(ledger().every((r) => r.transfers.every((t) => t.status === "pending" && t.batch === undefined)))
    assert.equal(evm.allowance(wallet.address, DISPERSE), BigInt(PNK("8734.5").toString()), "the approval stays, for the next run")
    fake.rejectIf = null
    const next = page(api, fake)
    assert.equal((await next.check("f", ["submissions", "removals"], { mode: "disperse" })).disperse.confirmations, 1)
    assert.equal((await next.disburse()).state, "done")
    assert.equal(paid().length, 3)
    assert.equal(fake.sent.length, 2, "the approval, then the batch: nothing sent twice")
  })

  it("settles from the chain a batch the wallet sent while the page lost its answer", async () => {
    writeFolder("f", { submissions: SUB, atq: ATQ })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions", "atq"], { mode: "disperse" })
    const approval = await api.nextBatch({ checkId: first.checkId })
    assert.equal(approval.state, "approve")
    assert.equal(approval.amount, PNK("4734.5").toString())
    const approvalHash = await fake.request({ method: "eth_sendTransaction", params: [approval.tx] })
    assert.equal((await api.sent({ requestId: approval.requestId, hash: approvalHash })).state, "sent")
    assert.equal((await api.receipt({ requestId: approval.requestId })).state, "confirmed")
    const batch = await api.nextBatch({ checkId: first.checkId })
    assert.equal(batch.state, "disperse")
    assert.equal(batch.transfers.length, 3)
    assert.ok(ledger().every((r) => r.transfers.every((t) => t.status === "requested" && t.batch === 3)), "recorded before the wallet is asked")
    await assert.rejects(
      sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "f") }, { log }),
      /was handed to a browser wallet by the disburse page/,
      "send leaves it to the page"
    )
    const hash = await fake.request({ method: "eth_sendTransaction", params: [batch.tx] }) // sent; the page closed before hearing it
    const reloaded = await page(api, fake).check("f", ["submissions", "atq"], { mode: "disperse" })
    assert.equal(reloaded.checkId, null)
    assert.equal(reloaded.notes.filter((n: string) => /the Disperse batch of 3 transfers, 4734\.5 PNK .*: the wallet sent it/.test(n)).length, 1, JSON.stringify(reloaded.notes))
    assert.ok(ledger().every((r) => r.status === "completed" && r.transfers.every((t) => t.status === "confirmed" && t.txHash === String(hash).toLowerCase())))
    assert.equal(paid().length, 3)
  })

  it("never takes for the batch's payment a transaction that is not exactly it, and settles it as one", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const elsewhere = evmAddress(0xbad)
    fake.tamper = (tx) =>
      tx.to.toLowerCase() === DISPERSE ? { ...tx, data: P.disperseData(evm.token, [elsewhere], [PNK(5).toString()]) } : tx
    const stopped: string[] = []
    const controller = page(api, fake, { stopped: (m: string) => stopped.push(m) })
    await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /is not the batch of 2 transfers .* it was asked for: its data is not disperseTokenSimple of this batch's 2 transfers/)
    const tampered = fake.sent[1].toLowerCase()
    assert.ok(ledger()[0].transfers.every((t) => t.status === "requested" && t.reportedTxHash === tampered))
    const again = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    assert.equal(again.unsettled.length, 1, "the batch is listed once")
    assert.equal(again.unsettled[0].batch, 2)
    assert.deepEqual(again.unsettled[0].actions, ["hash", "forget"])
    assert.match(again.unsettled[0].why, /^the Disperse batch of 2 transfers, 1,?734\.5 PNK .*which is not this batch/)
    assert.equal((await api.forget({ recordId: again.unsettled[0].recordId, index: again.unsettled[0].index })).state, "cleared")
    for (const t of ledger()[0].transfers) {
      assert.equal(t.status, "pending")
      assert.deepEqual(t.strayTxs, [tampered])
    }
    fake.tamper = null
    const retry = page(api, fake)
    assert.ok((await retry.check("f", ["submissions"], { mode: "disperse" })).checkId)
    assert.equal((await retry.disburse()).state, "done")
    assert.deepEqual(
      paid().map((p) => p.to.toLowerCase()),
      [elsewhere, ...SUB.map((e) => e.recipient)].map((a) => a.toLowerCase()),
      "the tampered batch paid only what it said; the batch itself, once"
    )
  })

  it("stops after the approval when asked to, before the batch: the next run needs one confirmation", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const stopped: string[] = []
    // eslint-disable-next-line prefer-const
    let controller: any
    controller = page(api, fake, {
      asking: (step: { state: string }) => step.state === "approve" && controller.stop(),
      stopped: (m: string) => stopped.push(m),
    })
    await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /Stopped after this one/)
    assert.equal(fake.sent.length, 1, "the approval only")
    assert.equal(paid().length, 0)
    const next = page(api, fake)
    assert.equal((await next.check("f", ["submissions"], { mode: "disperse" })).disperse.confirmations, 1)
    assert.equal((await next.disburse()).state, "done")
    assert.equal(paid().length, 2)
  })

  it("closes the payouts when stopped on the last transaction: nothing is left", async () => {
    writeFolder("f", { submissions: SUB })
    evm.setAllowance(wallet.address, DISPERSE, PNK("1734.5"))
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const done: string[] = []
    // eslint-disable-next-line prefer-const
    let controller: any
    controller = page(api, fake, { asking: () => controller.stop(), done: () => done.push("done") })
    await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal((await controller.disburse()).state, "done")
    assert.deepEqual(done, ["done"])
    assert.equal(ledger()[0].status, "completed")
    assert.equal((await api.overview()).folders[0].payouts[0].status, "disbursed")
  })

  // An old one-transfer request left open (marked never sent by mistake), approved after the batch was handed out.
  const lateSingle = async (api: any, fake: FakeWallet, folder: string, kinds: string[]): Promise<{ old: any; step: any }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const first = await page(api, fake).check(folder, kinds)
    const old = await api.next({ checkId: first.checkId }) // its popup stays open; the page reloads
    const reloaded = await page(api, fake).check(folder, kinds)
    assert.equal((await api.forget({ recordId: reloaded.unsettled[0].recordId, index: reloaded.unsettled[0].index })).state, "cleared")
    const batch = await page(api, fake).check(folder, kinds, { mode: "disperse" })
    const approval = await api.nextBatch({ checkId: batch.checkId })
    const approvalHash = await fake.request({ method: "eth_sendTransaction", params: [approval.tx] })
    await api.sent({ requestId: approval.requestId, hash: approvalHash })
    assert.equal((await api.receipt({ requestId: approval.requestId })).state, "confirmed")
    const step = await api.nextBatch({ checkId: batch.checkId })
    assert.equal(step.state, "disperse")
    return { old, step }
  }

  it("settles a batch as one: a late transfer paying one of its transfers is never taken for two", async () => {
    const X = evmAddress(0xf41)
    const Y = evmAddress(0xf42)
    writeFolder("f", { submissions: [{ recipient: X, amount: PNK(500) }, { recipient: Y, amount: PNK(600) }], atq: [{ recipient: X, amount: PNK(500) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const { old, step } = await lateSingle(api, fake, "f", ["submissions", "atq"])
    const late = String(await fake.request({ method: "eth_sendTransaction", params: [old.tx] })).toLowerCase() // the old popup, approved
    assert.equal((await api.rejected({ requestId: step.requestId })).state, "unsettled") // the batch's popup, rejected
    const after = await page(api, fake).check("f", ["submissions", "atq"], { mode: "disperse" })
    assert.equal(after.checkId, null)
    assert.equal(after.unsettled.length, 1)
    assert.ok(new RegExp(`Meanwhile ${late} \\(block \\d+\\) paid 500 PNK to ${X}`, "i").test(after.unsettled[0].why), after.unsettled[0].why)
    assert.ok(ledger().every((r) => r.transfers.every((t) => t.status === "requested")), "nothing taken for the batch's payment")
    const cleared = await api.forget({ recordId: after.unsettled[0].recordId, index: after.unsettled[0].index })
    assert.match(cleared.message, /The batch's 2 transfer\(s\) are marked as never sent.*1 of its transfers were paid by other transactions/s)
    const sub = ledger().find((r) => r.kind === "submissions") as DisbursementRecord
    const atq = ledger().find((r) => r.kind === "atq") as DisbursementRecord
    assert.equal(sub.transfers[0].status, "confirmed")
    assert.equal(sub.transfers[0].txHash, late)
    assert.equal(sub.transfers[0].batch, undefined, "out of the batch")
    assert.deepEqual([sub.transfers[1].status, atq.transfers[0].status], ["pending", "pending"])
    const rest = page(api, fake)
    assert.ok((await rest.check("f", ["submissions", "atq"], { mode: "disperse" })).checkId)
    assert.equal((await rest.disburse()).state, "done")
    const to = (a: string) => paid().filter((p) => p.to.toLowerCase() === a.toLowerCase()).length
    assert.deepEqual([to(X), to(Y)], [2, 1], "X owed 500 twice, paid twice; Y once")
    const last = await page(api, fake).check("f", ["submissions", "atq"], { mode: "disperse" })
    assert.ok(!last.problems.some((p: string) => /paid again/.test(p)), JSON.stringify(last.problems))
  })

  it("takes a batch mined after a late transfer for its payment, and reports the late one as a second payment", async () => {
    const X = evmAddress(0xf51)
    const Y = evmAddress(0xf52)
    writeFolder("f", { submissions: [{ recipient: X, amount: PNK(500) }, { recipient: Y, amount: PNK(600) }], atq: [{ recipient: X, amount: PNK(500) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const { old, step } = await lateSingle(api, fake, "f", ["submissions", "atq"])
    const late = String(await fake.request({ method: "eth_sendTransaction", params: [old.tx] })).toLowerCase()
    const batch = String(await fake.request({ method: "eth_sendTransaction", params: [step.tx] })).toLowerCase() // its answer lost
    const after = await page(api, fake).check("f", ["submissions", "atq"], { mode: "disperse" })
    assert.ok(after.notes.some((n: string) => n.includes(`the wallet sent it, ${batch}`)), JSON.stringify(after.notes))
    assert.ok(ledger().every((r) => r.transfers.every((t) => t.status === "confirmed" && t.txHash === batch)), "all three paid by the batch")
    assert.ok(after.problems.some((p: string) => new RegExp(`was paid again by ${late}`).test(p)), JSON.stringify(after.problems))
    const flagged = ledger().flatMap((r) => r.transfers).filter((t) => (t.paidTwiceBy || []).includes(late))
    assert.equal(flagged.length, 1, "one second payment, recorded on one transfer")
  })

  it("leaves every transfer of a batch that reverts to send again", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const checked = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    const approval = await api.nextBatch({ checkId: checked.checkId })
    await api.sent({ requestId: approval.requestId, hash: await fake.request({ method: "eth_sendTransaction", params: [approval.tx] }) })
    await api.receipt({ requestId: approval.requestId })
    const step = await api.nextBatch({ checkId: checked.checkId })
    evm.faults.revertTo = new Set([SUB[1].recipient.toLowerCase()]) // after the simulation: it reverts when mined
    const hash = String(await fake.request({ method: "eth_sendTransaction", params: [step.tx] })).toLowerCase()
    assert.equal((await api.sent({ requestId: step.requestId, hash })).state, "sent")
    assert.equal((await api.receipt({ requestId: step.requestId })).state, "reverted")
    for (const t of ledger()[0].transfers) {
      assert.equal(t.status, "failed")
      assert.deepEqual(t.revertedTxs, [hash])
    }
    evm.faults.revertTo = undefined
    const retry = page(api, fake)
    const again = await retry.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(again.disperse.confirmations, 1, "a reverted batch spent none of the approval")
    assert.equal((await retry.disburse()).state, "done")
    assert.equal(paid().length, 2)
  })

  it("settles a batch for all its transfers at once, from its one receipt, read once", async () => {
    writeFolder("october/combined", { submissions: SUB, removals: REM, atq: ATQ })
    const fake = new FakeWallet(wallet)
    // a node that does not serve the batch's receipt the first time it is asked for (one behind another)
    let asked = 0
    const api = await startPage({
      chainFor: (account) => {
        const chain = createSendChain({ readOnlyFrom: account })
        const batch = (hash: string) => fake.sent.length === 2 && hash.toLowerCase() === fake.sent[1].toLowerCase()
        return { ...chain, receipt: async (hash) => (batch(hash) && asked++ === 0 ? null : chain.receipt(hash)) }
      },
    })
    const controller = page(api, fake)
    await controller.check("october/combined", ALL, { mode: "disperse" })
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(asked, 2, "asked for once each time, not once per transfer")
    const records = ledger()
    assert.deepEqual(records.map((r) => r.status), ["completed", "completed", "completed"])
    for (const t of records.flatMap((r) => r.transfers)) {
      assert.deepEqual([t.status, t.txHash, typeof t.blockNumber], ["confirmed", fake.sent[1].toLowerCase(), "number"])
    }
    assert.equal(paid().length, 4)
  })

  it("stops, saying why, when the approval's amount was changed in the wallet: the batch needs exactly its total allowed", async () => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const stopped: string[] = []
    const asked: string[] = []
    const controller = page(api, fake, { stopped: (m: string) => stopped.push(m), asking: (step: { state: string }) => asked.push(step.state) })
    for (const [cap, shown] of [
      [PNK(100000), "100,000 PNK"], // raised in the wallet's approval screen
      [PNK(1000), "1,000 PNK"], // or lowered
    ] as [BigNumber, string][]) {
      await controller.check("f", ["submissions"], { mode: "disperse" })
      fake.tamper = (tx) => ({ ...tx, data: P.approveData(DISPERSE_ADDRESS, cap.toString()) })
      assert.equal(await controller.disburse(), null)
      fake.tamper = null
      assert.match(String(stopped.pop()), new RegExp(`is mined, but Disperse is allowed ${shown}, not the 1,734\\.5 PNK asked \\(was its amount changed in the wallet\\?\\)`))
      assert.deepEqual(asked.splice(0), ["approve"], "the batch is not handed out")
      assert.equal(paid().length, 0)
    }
    const again = await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(again.disperse.confirmations, 2)
    assert.ok(again.notes.some((n: string) => n.includes("for exactly 1,734.5 PNK (it is allowed 1,000 PNK now)")), JSON.stringify(again.notes))
    assert.equal((await controller.disburse()).state, "done")
    assert.equal(evm.allowance(wallet.address, DISPERSE), BigInt(0))
    assert.equal(paid().length, 2)
  })

  // The approval mined and the batch handed out, as a run does: the batch's step.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toBatch = async (api: any, fake: FakeWallet, kinds: string[]): Promise<any> => {
    const checked = await page(api, fake).check("f", kinds, { mode: "disperse" })
    assert.ok(checked.checkId, JSON.stringify(checked.problems))
    const approval = await api.nextBatch({ checkId: checked.checkId })
    assert.equal(approval.state, "approve")
    await api.sent({ requestId: approval.requestId, hash: await fake.request({ method: "eth_sendTransaction", params: [approval.tx] }) })
    assert.equal((await api.receipt({ requestId: approval.requestId })).state, "confirmed")
    const step = await api.nextBatch({ checkId: checked.checkId })
    assert.equal(step.state, "disperse")
    return step
  }

  // A batch sent, then sped up in the wallet (the same nonce), and the
  // operator gave the replacement's hash: the ledger holds both transactions.
  // The first one is the one mined after all (another node still had it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spedUpThenFirstMined = async (kinds: string[], before: () => void = () => undefined): Promise<{ api: any; first: string }> => {
    const fake = new FakeWallet(wallet)
    const running = await startPage()
    const step = await toBatch(running, fake, kinds)
    evm.autoMine = false
    const first = String(await fake.request({ method: "eth_sendTransaction", params: [step.tx] })).toLowerCase()
    assert.equal((await running.sent({ requestId: step.requestId, hash: first })).state, "sent")
    const nonce = Number(ledger()[0].transfers[0].nonce)
    const original = evm.mempool.slice()
    const second = String(await fake.signAndSend(step.tx, { max: "4", tip: "2" }, nonce)).toLowerCase() // this node now knows only the replacement
    const api = await startPage() // the page restarted
    const unsettled = (await api.check({ folder: "f", kinds, account: wallet.address, mode: "disperse" })).unsettled[0]
    await api.recordHash({ recordId: unsettled.recordId, index: unsettled.index, hash: second })
    assert.deepEqual(ledger()[0].transfers[0].attempts, [first, second])
    before()
    evm.mempool = original
    evm.mine()
    evm.autoMine = true
    return { api, first }
  }

  it("settles a batch from the receipt of whichever of its transactions was mined", async () => {
    writeFolder("f", { submissions: SUB, atq: ATQ })
    const { api, first } = await spedUpThenFirstMined(["submissions", "atq"])
    evm.faults.failNext = { eth_getLogs: 1000 } // from its receipt, not from the account's logs
    await api.check({ folder: "f", kinds: ["submissions", "atq"], account: wallet.address, mode: "disperse" })
    evm.faults.failNext = undefined
    assert.ok(ledger().every((r) => r.status === "completed" && r.transfers.every((t) => t.status === "confirmed" && t.txHash === first)))
    assert.equal(paid().length, 3)
  })

  it("tells a batch reverted when the one of its transactions that was mined reverted", async () => {
    writeFolder("f", { submissions: SUB })
    const { api, first } = await spedUpThenFirstMined(["submissions"], () => (evm.faults.revertTo = new Set([SUB[1].recipient.toLowerCase()])))
    evm.faults.revertTo = undefined
    const result = await api.check({ folder: "f", kinds: ["submissions"], account: wallet.address, mode: "disperse" })
    assert.equal(paid().length, 0)
    assert.ok(result.checkId, JSON.stringify([result.problems, result.unsettled]))
    assert.ok(ledger()[0].transfers.every((t) => t.status === "failed" && (t.revertedTxs || []).includes(first)), "known as reverted, to send again")
  })

  // An approval sent and not mined yet, then replaced in the wallet (the same
  // nonce) by `replacement`, which is mined: what its receipt call answers,
  // and whether the batch is handed out after it.
  const replacedApproval = async (replacement: (approval: { tx: Tx }) => Tx): Promise<{ state: string; batch: boolean }> => {
    writeFolder("f", { submissions: SUB })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const checked = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    evm.autoMine = false
    const approval = await api.nextBatch({ checkId: checked.checkId })
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "latest"]))
    const hash = await fake.request({ method: "eth_sendTransaction", params: [approval.tx] })
    assert.equal((await api.sent({ requestId: approval.requestId, hash })).state, "sent")
    assert.equal((await api.receipt({ requestId: approval.requestId })).state, "pending")
    await fake.signAndSend(replacement(approval), { max: "4", tip: "2" }, nonce)
    evm.mine()
    evm.autoMine = true
    const { state } = await api.receipt({ requestId: approval.requestId })
    const batch = await api.nextBatch({ checkId: checked.checkId }).then(
      (step: { state: string }) => step.state === "disperse",
      () => false
    )
    return { state, batch }
  }

  it("goes on after an approval sped up in the wallet, for the same amount", async () => {
    assert.deepEqual(await replacedApproval((approval) => approval.tx), { state: "confirmed", batch: true })
  })

  it("stops after an approval replaced in the wallet by one for another amount", async () => {
    const higher = (approval: { tx: Tx }) => ({ to: approval.tx.to, data: P.approveData(DISPERSE_ADDRESS, PNK(100000).toString()) })
    assert.deepEqual(await replacedApproval(higher), { state: "stopped", batch: false })
  })

  it("stops after an approval cancelled in the wallet", async () => {
    assert.deepEqual(await replacedApproval(() => ({ to: wallet.address, data: "0x" })), { state: "stopped", batch: false })
  })

  // An RPC served by several nodes: one a block behind the one that showed the
  // approval mined answers what was there before it, for `behind` reads.
  const laggingNode = (behind: { allowance: number; nonce: number; simulation: number }): SessionDeps => ({
    chainFor: (account) => {
      const chain = createSendChain({ readOnlyFrom: account })
      return {
        ...chain,
        tokenAllowance: async (spender) => (behind.allowance-- > 0 ? BigNumber.from(0) : chain.tokenAllowance(spender)),
        nonce: async (tag) => {
          const now = await chain.nonce(tag)
          if (behind.nonce <= 0) return now
          if (tag === "pending") behind.nonce -= 1
          return now - 1
        },
        simulateCall: async (to, data, label) => {
          if (to.toLowerCase() === DISPERSE_ADDRESS.toLowerCase() && behind.simulation-- > 0) throw new Error(`${label} would revert: nothing allowed`)
          return chain.simulateCall(to, data, label)
        },
      }
    },
  })

  it("goes on when a node answers a moment behind the approval it just showed mined", async () => {
    writeFolder("f", { submissions: SUB })
    const behind = { allowance: 0, nonce: 0, simulation: 0 }
    const api = await startPage(laggingNode(behind))
    const fake = new FakeWallet(wallet)
    const stopped: string[] = []
    const controller = page(api, fake, {
      // what the approval's receipt reads, then what is read before the batch is handed out
      sent: (step: { state: string }) => step.state === "approve" && (behind.allowance = 1),
      confirmed: (step: { state: string }) => step.state === "approve" && Object.assign(behind, { allowance: 1, nonce: 1, simulation: 1 }),
      stopped: (m: string) => stopped.push(m),
    })
    await controller.check("f", ["submissions"], { mode: "disperse" })
    const done = await controller.disburse()
    assert.deepEqual(stopped, [])
    assert.equal(done && done.state, "done")
    assert.equal(fake.sent.length, 2)
    assert.equal(paid().length, 2)
    assert.ok(behind.allowance <= 0 && behind.nonce <= 0 && behind.simulation <= 0, "each was read behind once")
  })

  it("stops, saying so, when the node stays behind: never a second approval, never a transaction on what it shows", async () => {
    writeFolder("f", { submissions: SUB })
    const behind = { allowance: 0, nonce: 0, simulation: 0 }
    const api = await startPage(laggingNode(behind))
    const fake = new FakeWallet(wallet)
    const stopped: string[] = []
    const controller = page(api, fake, {
      confirmed: (step: { state: string }) => step.state === "approve" && (behind.nonce = 1000),
      stopped: (m: string) => stopped.push(m),
    })
    await controller.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(await controller.disburse(), null)
    assert.match(stopped[0], /The RPC shows nonce \d+ for 0x[0-9a-fA-F]{40}, behind the \d+ the chain showed a moment ago \(a node lagging behind\): Check again/)
    assert.equal(fake.sent.length, 1, "the approval only")
    // the allowance, then: approved a moment ago, and not shown so
    behind.nonce = 0
    evm.setAllowance(wallet.address, DISPERSE, BigNumber.from(0))
    const again = page(api, fake, { confirmed: (step: { state: string }) => step.state === "approve" && (behind.allowance = 1000), stopped: (m: string) => stopped.push(m) })
    await again.check("f", ["submissions"], { mode: "disperse" })
    assert.equal(await again.disburse(), null)
    assert.match(stopped[1], /Disperse is allowed 0 PNK, not the 1,734\.5 PNK this run's approval allowed it a moment ago: Check again/)
    assert.equal(fake.sent.length, 2, "one more approval, and no batch")
    assert.equal(paid().length, 0)
    // caught up: one confirmation pays it
    behind.allowance = 0
    const last = page(api, fake)
    assert.equal((await last.check("f", ["submissions"], { mode: "disperse" })).disperse.confirmations, 1)
    assert.equal((await last.disburse()).state, "done")
    assert.equal(paid().length, 2)
  })

  it("refuses Disperse when the contract at its address is not Disperse", async () => {
    writeFolder("f", { submissions: SUB })
    evm.code.set(DISPERSE, "0x6080604052")
    const api = await startPage()
    const result = await page(api, new FakeWallet(wallet)).check("f", ["submissions"], { mode: "disperse" })
    assert.equal(result.checkId, null)
    assert.ok(result.problems.some((p: string) => /Disperse is not at 0xD152f549545093347A162Dce210e7293f1452150 on this chain as this page knows it/.test(p)))
    assert.ok((await page(api, new FakeWallet(wallet)).check("f", ["submissions"], { mode: "transfers" })).checkId, "one transaction per transfer still works")
  })
})

describe("disburse page: what the page holds the server to", () => {
  it("refuses a check whose answer does not hold together", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xd71), amount: PNK(5) }, { recipient: evmAddress(0xd72), amount: PNK(6) }] })
    const api = await startPage()
    const tampered = (change: (result: any) => void) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...api,
      check: async (body: unknown) => {
        const result = await api.check(body)
        change(result)
        return result
      },
    })
    const cases: [string, (result: any) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["a row neither paid nor ready", (r) => (r.payouts[0].transfers[1].status = "sent"), /a transfer of it is sent/],
      ["a total that is not its rows'", (r) => (r.due = PNK(1).toString()), /its total .* is not its rows'/],
      ["another account", (r) => (r.account = evmAddress(0x999)), /it is for 0x0+999/],
      ["another way of paying", (r) => (r.mode = "disperse"), /it pays with disperse, not transfers/],
    ]
    for (const [what, change, expected] of cases) {
      const controller = P.createController({ wallet: new FakeWallet(wallet), api: tampered(change), chainId: 100, token: evm.token, payer: null, sleep: async () => undefined })
      await assert.rejects(controller.check("f", ["submissions"]), expected, what)
      assert.equal(controller.canDisburse(), false, what)
    }
  })

  it("lists only real folders of files/: one file in two spellings is one payout, links are not followed", async () => {
    writeFolder("f", { removals: [{ recipient: evmAddress(0xd81), amount: PNK(5) }], atq: [{ recipient: evmAddress(0xd82), amount: PNK(6) }] })
    const manifest = join(work, "files", "f", "latest_removals_manifest.json")
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs")
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"))
    m.atqTransactionsFile = `./${m.transactionsFile}`
    writeJson(manifest, m)
    writeFolder("../elsewhere", { submissions: [{ recipient: evmAddress(0xd83), amount: PNK(7) }] })
    fs.symlinkSync(join(work, "elsewhere"), join(work, "files", "link"))
    const api = await startPage()
    const folders = (await api.overview()).folders
    assert.deepEqual(folders.map((f: { id: string }) => f.id), ["f"], "the link is not listed")
    assert.match(String(folders[0].payouts[1].problem), /for removals too: one file is one payout/)
    await assert.rejects(api.check({ folder: "link", kinds: ["submissions"], account: wallet.address }), /is not a folder of/)
  })

  it("shows the ledger's own error when it cannot be read, rather than payouts as not paid", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xd91), amount: PNK(5) }] })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs")
    fs.mkdirSync(join(work, "disbursements"), { recursive: true })
    fs.writeFileSync(join(work, "disbursements", "broken.json"), "{ not json")
    const api = await startPage()
    await assert.rejects(api.overview(), /\[disbursements\] .*broken\.json is not valid JSON/)
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
    // the box for this wallet's payments does not take another wallet's
    const unnamed = await page(api, fake).check("f", ["submissions"], { skipPaidOnChain: true })
    assert.equal(unnamed.checkId, null)
    assert.match(String(unnamed.payouts[0].refusal), /--paid-tx/)
    // it is this payout's payment, named: recorded as paid, and only the rest is sent
    const controller = page(api, fake)
    const recorded = await controller.check("f", ["submissions"], { paidTxs: [found] })
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
    const found = evm.addPastTransfer(Wallet.createRandom().address, SUB[0].recipient, SUB[0].amount)
    const api = await startPage()
    const result = await page(api, new FakeWallet(wallet)).check("f", ["submissions"], { paidTxs: [found] })
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
    assert.match(String(theirs.payouts[0].refusal), /was handed to a browser wallet by the disburse page/)
  })

  it("never moves to another account a payout with a transfer once handed to a wallet and marked never sent", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xe25), amount: PNK(5) }] })
    const api = await startPage()
    const first = await page(api, new FakeWallet(wallet)).check("f", ["submissions"])
    await api.next({ checkId: first.checkId }) // its popup may still be open in this account's wallet
    const second = await page(api, new FakeWallet(wallet)).check("f", ["submissions"])
    assert.equal((await api.forget({ recordId: second.unsettled[0].recordId, index: 0 })).state, "cleared")
    assert.equal(ledger()[0].transfers[0].neverSent, 1)
    const other = Wallet.createRandom()
    evm.setTokenBalance(other.address, PNK(100))
    evm.setNativeBalance(other.address, utils.parseEther("1"))
    const result = await page(api, new FakeWallet(other)).check("f", ["submissions"])
    assert.equal(ledger()[0].from, wallet.address, "it stays with that account")
    assert.equal(result.checkId, null)
    assert.match(String(result.payouts[0].refusal), /was started from .* the account sending now is/)
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

  it("records once the same answer given twice, across a reload", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xa33), amount: PNK(5) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = await page(api, fake).check("f", ["submissions"])
    const step = await api.next({ checkId: first.checkId })
    const ghost = `0x${"ef".repeat(32)}`
    assert.equal((await api.sent({ requestId: step.requestId, hash: ghost })).state, "unverified")
    await page(api, fake).check("f", ["submissions"]) // another tab
    await assert.rejects(api.sent({ requestId: step.requestId, hash: ghost }), /is recorded already/)
    const t = ledger()[0].transfers[0]
    assert.equal(t.reportedTxHash, ghost)
    assert.equal(t.strayTxs, undefined, "not taken for another hand-out's answer")
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

  it("takes what pays a transfer not settled yet for its payment, not for a second payment of an older one", async () => {
    const X = evmAddress(0xa41)
    writeFolder("a", { removals: [{ recipient: X, amount: PNK(7000) }] }, 1790000000071)
    const api = await startPage()
    const first = page(api, new FakeWallet(wallet))
    await first.check("a", ["removals"])
    assert.equal((await first.disburse()).state, "done")
    // the month's submissions pay X the same amount: send broadcast it, and stopped before it was mined
    writeFolder("b", { submissions: [{ recipient: X, amount: PNK(7000) }] })
    evm.autoMine = false
    await assert.rejects(sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "b") }, { log }), /was not mined within/)
    evm.mine()
    evm.autoMine = true
    assert.equal(paid().length, 2)
    // mined, and the ledger does not say so yet
    const result = await api.check({ folder: "a", kinds: ["removals"], account: wallet.address })
    assert.ok(!result.problems.some((p: string) => /paid again/.test(p)), JSON.stringify(result.problems))
    assert.ok(ledger().every((r) => r.transfers.every((t) => t.paidTwiceBy === undefined)))
  })

  it("counts one stray payment as one second payment, of one transfer, whatever checks follow", async () => {
    const X = evmAddress(0xa45)
    writeFolder("a", { removals: [{ recipient: X, amount: PNK(7000) }] }, 1790000000071)
    writeFolder("b", { submissions: [{ recipient: X, amount: PNK(7000) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    for (const [folder, kind] of [
      ["a", "removals"],
      ["b", "submissions"],
    ]) {
      const controller = page(api, fake)
      const result = await controller.check(folder, [kind])
      assert.ok(result.checkId, JSON.stringify([result.problems, result.payouts[0].refusal]))
      assert.equal((await controller.disburse()).state, "done")
    }
    // X is sent the amount a third time, outside the page
    const stray = String(await fake.signAndSend({ to: evm.token, data: P.transferData(X, PNK(7000).toString()) })).toLowerCase()
    const flagged = await api.check({ folder: "a", kinds: ["removals"], account: wallet.address })
    assert.equal(flagged.problems.filter((p: string) => /paid again/.test(p)).length, 1, JSON.stringify(flagged.problems))
    const after = await api.check({ folder: "a", kinds: ["removals"], account: wallet.address })
    assert.ok(!after.problems.some((p: string) => /paid again/.test(p)), JSON.stringify(after.problems))
    assert.deepEqual(
      ledger().flatMap((r) => r.transfers.map((t) => t.paidTwiceBy || [])).filter((hashes) => hashes.length > 0),
      [[stray]]
    )
  })

  it("records one second payment per transfer when one transaction pays two transfers to one recipient again", async () => {
    // one address owed the same amount twice in a batch (as remover and as ATQ requester), and the batch sent twice
    const X = evmAddress(0xa51)
    const Y = evmAddress(0xa52)
    writeFolder("f", { removals: [{ recipient: X, amount: PNK(500) }, { recipient: Y, amount: PNK(600) }], atq: [{ recipient: X, amount: PNK(500) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const controller = page(api, fake)
    await controller.check("f", ["removals", "atq"], { mode: "disperse" })
    assert.equal((await controller.disburse()).state, "done")
    evm.setAllowance(wallet.address, DISPERSE, PNK(1600))
    const data = P.disperseData(evm.token, [X, Y, X], [PNK(500), PNK(600), PNK(500)].map(String))
    const stray = String(await fake.signAndSend({ to: DISPERSE, data })).toLowerCase()
    assert.equal(paid().length, 6)
    const again = (problems: string[]) => problems.filter((p) => /paid again/.test(p)).length
    const check = () => api.check({ folder: "f", kinds: ["removals", "atq"], account: wallet.address, mode: "disperse" })
    assert.equal(again((await check()).problems), 3, "each of the three transfers, once")
    assert.equal(again((await check()).problems), 0)
    assert.equal(again((await check()).problems), 0)
    assert.deepEqual(ledger().flatMap((r) => r.transfers.map((t) => t.paidTwiceBy)), [[stray], [stray], [stray]])
  })

  it("never reports again a second payment recorded on a transfer it no longer watches", async () => {
    // X owed the same amount by two payouts paid through the page, then sent it a third time
    const X = evmAddress(0xa55)
    writeFolder("a", { removals: [{ recipient: X, amount: PNK(7000) }] }, 1790000000071)
    writeFolder("b", { submissions: [{ recipient: X, amount: PNK(7000) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    for (const [folder, kind] of [
      ["a", "removals"],
      ["b", "submissions"],
    ]) {
      const controller = page(api, fake)
      await controller.check(folder, [kind])
      assert.equal((await controller.disburse()).state, "done")
    }
    const stray = String(await fake.signAndSend({ to: evm.token, data: P.transferData(X, PNK(7000).toString()) })).toLowerCase()
    const check = async () => (await api.check({ folder: "a", kinds: ["removals"], account: wallet.address })).problems.filter((p: string) => /paid again/.test(p))
    assert.equal((await check()).length, 1)
    const holder = ledger().find((r) => r.transfers.some((t) => (t.paidTwiceBy || []).length > 0)) as DisbursementRecord
    // 46 days on for the transfer that holds it (the other one was paid later): it is no longer looked at
    holder.transfers[0].requestedAt = new Date(Date.now() - 46 * 86400000).toISOString()
    saveDisbursement(holder)
    assert.deepEqual(await check(), [])
    assert.deepEqual(ledger().flatMap((r) => r.transfers.map((t) => t.paidTwiceBy || [])).filter((hashes) => hashes.length > 0), [[stray]])
  })

  it("takes the late payment of a transfer handed to a wallet for that transfer's, whose hash it never knew", async () => {
    // an older transfer to X for the same amount, paid through the page
    const X = evmAddress(0xa61)
    const Y = evmAddress(0xa62)
    writeFolder("a", { removals: [{ recipient: X, amount: PNK(500) }] }, 1790000000071)
    writeFolder("f", { submissions: [{ recipient: X, amount: PNK(500) }, { recipient: Y, amount: PNK(600) }] })
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const older = page(api, fake)
    await older.check("a", ["removals"])
    assert.equal((await older.disburse()).state, "done")
    // X's transfer handed out alone, its popup left open and marked never sent; then the batch handed out,
    // the old popup approved, and the batch's rejected: the batch is left to the operator, X paid by the old request
    const first = await page(api, fake).check("f", ["submissions"])
    const old = await api.next({ checkId: first.checkId })
    const reloaded = await page(api, fake).check("f", ["submissions"])
    assert.equal((await api.forget({ recordId: reloaded.unsettled[0].recordId, index: reloaded.unsettled[0].index })).state, "cleared")
    const batch = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    const approval = await api.nextBatch({ checkId: batch.checkId })
    await api.sent({ requestId: approval.requestId, hash: await fake.request({ method: "eth_sendTransaction", params: [approval.tx] }) })
    assert.equal((await api.receipt({ requestId: approval.requestId })).state, "confirmed")
    const step = await api.nextBatch({ checkId: batch.checkId })
    await fake.request({ method: "eth_sendTransaction", params: [old.tx] })
    assert.equal((await api.rejected({ requestId: step.requestId })).state, "unsettled")
    const after = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    assert.ok(!after.problems.some((p: string) => /paid again/.test(p)), JSON.stringify(after.problems))
    await api.forget({ recordId: after.unsettled[0].recordId, index: after.unsettled[0].index })
    const rest = page(api, fake)
    if ((await rest.check("f", ["submissions"], { mode: "disperse" })).checkId) assert.equal((await rest.disburse()).state, "done")
    const last = await page(api, fake).check("f", ["submissions"], { mode: "disperse" })
    assert.ok(!last.problems.some((p: string) => /paid again/.test(p)), JSON.stringify(last.problems))
    const to = (a: string) => paid().filter((p) => p.to.toLowerCase() === a.toLowerCase()).length
    assert.deepEqual([to(X), to(Y)], [2, 1], "X owed 500 twice, paid twice; Y once")
    assert.ok(ledger().every((r) => r.transfers.every((t) => (t.paidTwiceBy || []).length === 0)), "nobody was paid twice")
  })

  it("reports a real second payment once the transfer it could have been for is settled", async () => {
    const X = evmAddress(0xa65)
    writeFolder("a", { removals: [{ recipient: X, amount: PNK(7000) }] }, 1790000000071)
    const api = await startPage()
    const fake = new FakeWallet(wallet)
    const first = page(api, fake)
    await first.check("a", ["removals"])
    assert.equal((await first.disburse()).state, "done")
    // X is sent the amount again, outside the page; then send signs the month's submissions (X, the same amount)
    const stray = String(await fake.signAndSend({ to: evm.token, data: P.transferData(X, PNK(7000).toString()) })).toLowerCase()
    writeFolder("b", { submissions: [{ recipient: X, amount: PNK(7000) }] })
    const send = () => sendRoutine({ file: "1790000000001.json", filesDir: join(work, "files", "b"), skipOnchainCheck: true }, { log })
    evm.autoMine = false
    await assert.rejects(send(), /was not mined within/)
    const check = async () => (await api.check({ folder: "a", kinds: ["removals"], account: wallet.address })).problems.filter((p: string) => /paid again/.test(p))
    assert.deepEqual(await check(), [], "it may be that transfer's payment: left to its settling")
    evm.mine()
    evm.autoMine = true
    await send()
    assert.equal((await check()).length, 1, "settled by its own transaction: the other one is a second payment")
    assert.deepEqual(ledger().flatMap((r) => r.transfers.map((t) => t.paidTwiceBy || [])).filter((hashes) => hashes.length > 0), [[stray]])
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

    // A request line no browser writes, with everything else the page sends: a
    // name every object has, in place of a path, reaches nothing of the API.
    const line = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = connect(Number(port), hostname, () => {
          socket.write(
            `POST ${target} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${base}\r\nX-Disburse-Session: ${TOKEN}\r\n` +
              "Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
          )
        })
        let answer = ""
        socket.on("data", (chunk) => (answer += String(chunk)))
        socket.on("close", () => resolve(Number((/^HTTP\/1\.1 (\d+)/.exec(answer) || [])[1] || 0)))
        socket.on("error", reject)
      })
    assert.equal(await line("/api/overview"), 200)
    for (const target of ["/constructor", "/__proto__", "/toString"]) assert.equal(await line(target), 404, target)
    for (const target of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.notEqual(await line(target), 200, target)

    // An object where the page sends text reads as nothing, and is refused.
    const odd = await fetch(`${base}/api/next`, { method: "POST", headers: good, body: JSON.stringify({ checkId: { a: 1 } }) })
    assert.deepEqual([odd.status, (await odd.json()).ok], [200, false])
  })
})

describe("disburse page: starting it", () => {
  const lockFile = () => join(disbursementsDir(), ".lock")
  // The routine as `--mode disburse-page` runs it, on `port`, without its lines on the terminal.
  const start = async (port: string): Promise<Server> => {
    const restore = setEnv({ DISBURSE_PAGE_PORT: port })
    const print = console.log
    console.log = () => undefined
    try {
      return await disbursePageRoutine()
    } finally {
      console.log = print
      restore()
    }
  }

  it("leaves the ledger's lock free when it cannot start", async () => {
    const taken = createTcpServer()
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()))
    const refusals: [string, RegExp][] = [
      ["70000", /port/i],
      ["abc", /Invalid DISBURSE_PAGE_PORT="abc"/],
      [String((taken.address() as AddressInfo).port), /Port \d+ is taken: stop what holds it/],
    ]
    try {
      for (const [port, why] of refusals) {
        await assert.rejects(start(port), why)
        assert.equal(existsSync(lockFile()), false, port)
        acquireDisbursementLock()() // free: taken, and given back
      }
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()))
    }
  })

  it("holds the lock while it serves, against send and against a second page, and gives it back when closed", async () => {
    const free = createTcpServer()
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", () => resolve()))
    const port = String((free.address() as AddressInfo).port)
    await new Promise<void>((resolve) => free.close(() => resolve()))
    const serving = await start(port)
    try {
      assert.equal(existsSync(lockFile()), true)
      assert.throws(() => acquireDisbursementLock(), /is held by|Another run/)
      await assert.rejects(start(port), /is held by|Another run/)
      assert.equal(existsSync(lockFile()), true, "a second start does not free the first one's lock")
    } finally {
      await new Promise<void>((resolve) => serving.close(() => resolve()))
    }
    assert.equal(existsSync(lockFile()), false)
    acquireDisbursementLock()()
  })
})

describe("disburse page and send: one ledger", () => {
  const X = evmAddress(0xc31)
  const Y = evmAddress(0xc32)
  const payInOneBatch = async (): Promise<string> => {
    writeFolder("m", { submissions: [{ recipient: X, amount: PNK(500) }, { recipient: Y, amount: PNK(10) }], removals: [{ recipient: evmAddress(0xc33), amount: PNK(7) }] })
    const api = await startPage()
    const controller = page(api, new FakeWallet(wallet))
    assert.ok((await controller.check("m", ["submissions", "removals"], { mode: "disperse" })).checkId)
    assert.equal((await controller.disburse()).state, "done")
    const hashes = new Set(ledger().flatMap((r) => r.transfers.map((t) => t.txHash)))
    assert.equal(hashes.size, 1, "one batch pays both payouts")
    return Array.from(hashes)[0] as string
  }

  it("send tells a batch's payments apart by payout: a repeat of one of them is refused", async () => {
    await payInOneBatch()
    writeFolder("m", { submissions: [{ recipient: X, amount: PNK(500) }, { recipient: evmAddress(0xc34), amount: PNK(3) }] }, 1790000000101)
    await assert.rejects(
      sendRoutine({ file: "1790000000101.json", filesDir: join(work, "files", "m"), allowRepeatPeriod: true, dryRun: true }, { log }),
      /1 of the 2 transfers to send repeat transfers this wallet already paid/
    )
  })

  it("send sets aside one transfer of a batch named hash:recipient, never a whole batch by its hash", async () => {
    const batch = await payInOneBatch()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("fs").rmSync(join(work, "disbursements"), { recursive: true, force: true }) // another machine, without this ledger
    const opts = { file: "1790000000001.json", filesDir: join(work, "files", "m"), dryRun: true }
    await assert.rejects(sendRoutine({ ...opts, unrelatedTxs: [batch] }, { log }), /names a transaction paying several of this payout's transfers/)
    await assert.rejects(
      sendRoutine({ ...opts, unrelatedTxs: [`${batch}:${X}`] }, { log }),
      new RegExp(`1 of the 2 transfers to send repeat transfers this wallet already paid.*${Y}`, "si"),
      "X set aside, Y still found paid"
    )
    await assert.rejects(sendRoutine({ ...opts, unrelatedTxs: ["0x1234"] }, { log }), /is not a transaction hash .*nor a hash and a recipient/)
  })

  it("send records another wallet's payment only when it is named (--paid-tx), not with --skip-paid-on-chain", async () => {
    writeFolder("f", { submissions: [{ recipient: evmAddress(0xc41), amount: PNK(5) }, { recipient: evmAddress(0xc42), amount: PNK(6) }] })
    const elsewhere = evm.addPastTransfer(Wallet.createRandom().address, evmAddress(0xc41), PNK(5))
    const opts = { file: "1790000000001.json", filesDir: join(work, "files", "f"), dryRun: true }
    await assert.rejects(sendRoutine({ ...opts, skipPaidOnChain: true }, { log }), /from another wallet.*--paid-tx <hash>/s)
    const result = await sendRoutine({ ...opts, paidTxs: [elsewhere] }, { log })
    assert.equal((result.record as DisbursementRecord).transfers[0].status, "confirmed")
    assert.equal((result.record as DisbursementRecord).transfers[0].paidBy !== undefined, true)
    assert.equal(paid().length, 0, "a dry run")
  })

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
