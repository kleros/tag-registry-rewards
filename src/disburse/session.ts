import { randomBytes } from "crypto"
import { BigNumber, utils } from "ethers"
import conf from "../config"
import { humanizeAmount } from "../transaction-sender"
import { clearTransaction, isRequested, sendRoutine, SendRefusedError, settle } from "../send-routine"
import {
  DisbursementKind,
  DisbursementRecord,
  displayPath,
  LedgerTransfer,
  listDisbursements,
  periodLabel,
  recordPath,
  saveDisbursement,
} from "../utils/disbursement-ledger"
import { envInt, errorMessage, sleep } from "../utils/runtime-helpers"
import {
  createSendChain,
  explorerTxUrl,
  SendChain,
  sendChainId,
  sendTokenAddress,
  TransactionDetails,
  transferCalldata,
} from "../utils/send-chain"
import { FolderPayout, folderPayouts, listPayoutFolders, PAYOUT_KINDS, PayoutFolder, resolvePayoutFolder } from "./folders"

// What the disburse page does on this machine (server.ts serves it). The page
// only relays: it asks for a check, then for one transfer at a time, hands
// each to the browser wallet, and reports what the wallet answered. Every
// decision is taken here, with send's own checks and ledger:
//
// - a check is send's dry run as the wallet's account, for each payout of the
//   chosen folder: every refusal of `--mode send` applies (a payout already
//   disbursed, another file for a month already paid, transfers found on-chain
//   from this wallet or any other, the period not over, the funds), plus none
//   of the account's transactions pending;
// - a transfer is recorded as handed to the wallet ("requested", with the
//   account's next nonce and the chain's block) before the wallet is asked,
//   only while the account has sent nothing since the check but this page's
//   own transfers, and only once it succeeds simulated (eth_call);
// - the hash the wallet answers is recorded at once, whenever it comes (a
//   late answer, after a reload or from another tab, too), and the transaction
//   is only taken for the transfer once the chain shows it is exactly that:
//   from the account, to PNK, transfer(recipient, amount), no value;
// - a transfer is only ever settled from the chain: mined (its own
//   transaction, or the wallet's replacement of it, found by receipt or in the
//   account's Transfer logs), or still pending. When the chain cannot say (the
//   wallet never answered, or its transaction can no longer be mined and
//   nothing pays it), the operator decides, by its hash from the wallet's
//   activity or by "never sent", which is refused whenever the wallet answered
//   a hash for it, something of the account's is pending, or anything pays it.
//   Nothing is ever forgotten on its own, and nothing is sent twice.

const ZERO = BigNumber.from(0)
const pnk = (wei: BigNumber | string): string => `${humanizeAmount(BigNumber.from(wei))} PNK`
const hexQuantity = (n: number): string => `0x${n.toString(16)}`
const PLAN_MINUTES = 30
const HASH = /^0x[0-9a-f]{64}$/
// How long after a transfer was handed to a wallet a second payment of it is
// looked for, at each check.
const REPEAT_DAYS = 45
// send's refusals name its flags; the page has two of them.
const PAGE_OPTIONS =
  "\n(On this page, --unrelated-tx and --skip-paid-on-chain are the two options under \"Transfers the check finds already " +
  "on-chain\"; --skip-onchain-check is only in yarn start --mode send.)"

export interface Tx {
  from: string
  to: string
  data: string
  value: string
  chainId: string
}

export interface PlannedTransfer {
  index: number
  recipient: string
  amount: string // wei
  status: LedgerTransfer["status"]
  txHash?: string
  url?: string | null
}

export interface PlannedPayout {
  kind: DisbursementKind
  file: string
  period: string
  total: string
  due: string // still to send
  toSend: number
  transfers: PlannedTransfer[]
  ledger?: string // its record, once it has one
  refusal?: string // why it cannot be paid
  log: string[] // send's own account of the checks
}

// A transfer handed to a wallet that the chain does not settle on its own.
// `actions`: what the operator may do from the page ("hash": give the hash the
// wallet's activity shows; "forget": say it was never sent).
export interface UnsettledTransfer {
  ledger: string
  recordId: string
  index: number
  recipient: string
  amount: string
  from: string
  requestedAt?: string
  requestedNonce?: number
  actions: ("hash" | "forget")[]
  why: string
}

export interface CheckResult {
  checkId: string | null // null: nothing may be sent (see problems)
  folder: string
  account: string
  chainId: number
  token: string
  nonce: number
  balance: string
  native: string
  due: string
  payouts: PlannedPayout[]
  problems: string[] // what stops everything
  notes: string[]
  unsettled: UnsettledTransfer[]
}

export type Step =
  | { state: "send"; requestId: string; kind: DisbursementKind; index: number; recipient: string; amount: string; tx: Tx }
  | { state: "done"; payouts: { kind: DisbursementKind; ledger: string; status: string }[] }

export type Receipt =
  | { state: "pending"; hash: string }
  | { state: "confirmed"; hash: string; block: number; url: string | null; note?: string }
  | { state: "reverted"; hash: string; message: string }
  | { state: "stopped"; message: string }

interface PlanPayout {
  kind: DisbursementKind
  file: string
  record: DisbursementRecord
}

interface Plan {
  checkId: string
  account: string
  payouts: PlanPayout[]
  expectedNonce: number // the account's next nonce: anything else it sends voids the plan
  touchedAt: number
}

// A transfer handed to the wallet, by the id the page got for it. Kept for
// the server's life: an answer for it is recorded whenever it comes.
interface Issued {
  recordId: string
  index: number
  requestedNonce: number
  data: string
}

// The transfer with the wallet in the run going on now.
interface Active {
  requestId: string
  payout: PlanPayout
  transfer: LedgerTransfer
  index: number
  data: string
  nonce: number // the account's next nonce when it was handed to the wallet
  hash?: string
  verified: boolean
}

export interface SessionDeps {
  root?: string // FILES_DIR
  chainFor?: (account: string) => SendChain
  waitMs?: number // how long a receipt call waits before answering "pending"
}

const randomId = (): string => randomBytes(16).toString("hex")

// The account the page pays from: SEND_FROM when set, else whichever account
// the wallet has selected.
export const pinnedPayer = (): string | null => {
  const raw = String(process.env.SEND_FROM || "").trim()
  if (!raw) return null
  if (!utils.isAddress(raw)) throw new Error(`SEND_FROM="${raw}" is not an address`)
  return utils.getAddress(raw)
}

// Why a transaction is not exactly the transfer, or "".
export const transferMismatch = (
  tx: TransactionDetails,
  expected: { from: string; token: string; data: string; chainId: number; minNonce?: number }
): string => {
  if (tx.from.toLowerCase() !== expected.from.toLowerCase()) return `it is from ${tx.from}, not ${expected.from}`
  if (!tx.to || tx.to.toLowerCase() !== expected.token.toLowerCase()) return `it is to ${tx.to}, not PNK (${expected.token})`
  if (tx.input.toLowerCase() !== expected.data.toLowerCase()) return "its data is not transfer(recipient, amount) of this transfer"
  if (!tx.value.isZero()) return `it carries ${utils.formatEther(tx.value)} of the native token`
  if (tx.chainId !== null && tx.chainId !== expected.chainId) return `it is for chain ${tx.chainId}, not ${expected.chainId}`
  if (expected.minNonce !== undefined && tx.nonce < expected.minNonce) {
    return `its nonce ${tx.nonce} was used before the transfer was handed to the wallet (nonce ${expected.minNonce})`
  }
  return ""
}

const paidHashes = (t: LedgerTransfer): string[] =>
  (t.attempts || []).concat(t.txHash ? [t.txHash] : []).map((h) => h.toLowerCase())

// Every hash that may be this transfer's own transaction.
const ownHashes = (t: LedgerTransfer): Set<string> =>
  new Set(paidHashes(t).concat(t.reportedTxHash ? [t.reportedTxHash.toLowerCase()] : []))

// Every hash the ledger holds as paying a transfer, but this one's (the
// record's transfer at `index`; records are read anew from disk each time).
const ledgerHashesBut = (recordId: string, index: number): Set<string> =>
  new Set(
    listDisbursements().flatMap((r) => r.transfers.filter((_, i) => !(r.id === recordId && i === index)).flatMap(paidHashes))
  )

const union = (a: string[] | undefined, b: string[]): string[] => Array.from(new Set((a || []).concat(b.map((h) => h.toLowerCase()))))

// Nothing of the transfer ever left the wallet: no transaction of it, mined,
// reverted, forgotten or answered.
const untouched = (t: LedgerTransfer): boolean =>
  t.status === "pending" &&
  !t.txHash &&
  !t.reportedTxHash &&
  !(t.attempts || []).length &&
  !(t.revertedTxs || []).length &&
  !(t.forgottenTxs || []).length &&
  !(t.strayTxs || []).length &&
  !t.foundOnChain

export class DisburseSession {
  private plan: Plan | null = null
  private active: Active | null = null
  private readonly issued = new Map<string, Issued>()
  private readonly root: string
  private readonly waitMs: number

  constructor(private readonly deps: SessionDeps = {}) {
    this.root = deps.root || conf.FILES_DIR
    this.waitMs = deps.waitMs === undefined ? 20000 : deps.waitMs
  }

  private chain(account: string): SendChain {
    return this.deps.chainFor ? this.deps.chainFor(account) : createSendChain({ readOnlyFrom: account })
  }

  // What the page shows first: the folders, the chain, and the payer pinned.
  overview(): { chainId: number; token: string; payer: string | null; folders: PayoutFolder[] } {
    return { chainId: sendChainId(), token: sendTokenAddress(), payer: pinnedPayer(), folders: listPayoutFolders(this.root) }
  }

  // --- checking --------------------------------------------------------------

  async check(input: {
    folder: string
    kinds: string[]
    account: string
    unrelatedTxs?: string[]
    skipPaidOnChain?: boolean
  }): Promise<CheckResult> {
    // A check starts over (the page reloaded, or another tab checks): the
    // transfer with the wallet stays in the ledger, settled below like any,
    // and an answer for it is still recorded when it comes (`issued`).
    this.active = null
    this.plan = null
    if (!utils.isAddress(String(input.account || ""))) throw new SendRefusedError(`"${input.account}" is not an account`)
    const account = utils.getAddress(String(input.account))
    const pinned = pinnedPayer()
    if (pinned && pinned !== account) {
      throw new SendRefusedError(`The wallet's account is ${account}, not ${pinned} (SEND_FROM): select that account in the wallet`)
    }
    const dir = resolvePayoutFolder(String(input.folder), this.root)
    const available = folderPayouts(dir)
    const kinds = PAYOUT_KINDS.filter((k) => (input.kinds || []).includes(k))
    if (kinds.length === 0) throw new SendRefusedError("Choose at least one payout: submissions, removals or ATQ")
    for (const kind of kinds) {
      if (!available.some((p) => p.kind === kind)) throw new SendRefusedError(`${input.folder} has no ${kind} payout`)
    }
    const unrelatedTxs = (input.unrelatedTxs || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean)
    for (const hash of unrelatedTxs) {
      if (!HASH.test(hash)) throw new SendRefusedError(`"${hash}" is not a transaction hash (0x and 64 hex digits)`)
    }
    const skipPaidOnChain = !!input.skipPaidOnChain

    const chainId = sendChainId()
    const token = sendTokenAddress()
    const chain = this.chain(account)
    const network = await chain.networkChainId()
    if (network !== chainId) {
      throw new SendRefusedError(`The RPC answers for chain ${network}, not TX_NETWORK_ID=${chainId}. Check TX_RPC_URL.`)
    }

    const problems: string[] = []
    const notes: string[] = []
    this.rebindUntouched(account, notes)
    // Transfers handed to a wallet before are settled first: until this
    // account's are, nothing else may be sent (one may hold its next nonce).
    // Another account's only stop its own payout (send refuses it).
    const unsettled = await this.settleWalletTransfers(chain, account, notes)
    const blocking = unsettled.filter((u) => u.from.toLowerCase() === account.toLowerCase())
    for (const u of unsettled) (blocking.includes(u) ? problems : notes).push(u.why)
    await this.findRepeats(chain, account, problems, notes)

    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (pending > latest) {
      problems.push(
        `${account} has ${pending - latest} transaction(s) pending: wait until they are mined (or cancel them in the wallet), then Check again`
      )
    }

    const payouts: PlannedPayout[] = []
    const planned: PlanPayout[] = []
    for (const kind of kinds) {
      const listed = available.find((p) => p.kind === kind) as FolderPayout
      const { file, period } = listed
      const lines: string[] = []
      try {
        if (listed.problem) throw new SendRefusedError(`Refusing to send: ${listed.problem}`)
        if (blocking.length > 0) throw new SendRefusedError("Settle the transfers handed to a wallet before (listed above) first")
        const result = await sendRoutine(
          { file, filesDir: dir, dryRun: true, from: account, unrelatedTxs, skipPaidOnChain, walletFees: true },
          { chain, log: (line) => lines.push(line) }
        )
        const record = result.record as DisbursementRecord
        // Transactions `--mode send` signed and saved: only send rebroadcasts
        // or replaces them, and it cannot run while the page holds the ledger.
        const signed = record.transfers.filter((t) => (t.status === "signed" || t.status === "sent") && !t.viaWallet)
        if (signed.length > 0) {
          throw new SendRefusedError(
            `${signed.length} transfer(s) of it were signed by yarn start --mode send and are not settled yet: stop this page ` +
              `(Ctrl-C) and rerun send on ${file} to finish it (it waits for them, or rebroadcasts them as signed), then Check again`
          )
        }
        const twin = planned.find((q) => q.record.id === record.id)
        if (twin) throw new SendRefusedError(`Refusing to send: it is the very payout ${twin.kind} pays (${twin.file}): one payout is paid once`)
        this.keepSettled(record, skipPaidOnChain, notes)
        const open = record.transfers.filter((t) => t.status !== "confirmed")
        payouts.push({
          kind,
          file,
          period,
          total: record.total,
          due: open.reduce((sum, t) => sum.add(t.amount), ZERO).toString(),
          toSend: open.length,
          transfers: this.describeTransfers(record),
          ...(listDisbursements().some((r) => r.id === record.id) ? { ledger: displayPath(recordPath(record)) } : {}),
          log: lines,
        })
        if (open.length > 0) planned.push({ kind, file, record })
      } catch (err) {
        const refusal = err instanceof SendRefusedError ? err.message : `Could not check it: ${errorMessage(err)}`
        payouts.push({
          kind,
          file,
          period,
          total: "0",
          due: "0",
          toSend: 0,
          transfers: [],
          refusal: refusal + (/--skip-paid-on-chain|--unrelated-tx/.test(refusal) ? PAGE_OPTIONS : ""),
          log: lines,
        })
      }
    }

    // A payout chosen and refused (but for being paid already) stops the run:
    // paying only the rest has to be a choice, made by unticking it.
    const disbursed = new Set(folderPayouts(dir).filter((p) => p.status === "disbursed").map((p) => p.kind))
    const refused = payouts.filter((p) => p.refusal && !disbursed.has(p.kind))
    if (refused.length > 0) {
      problems.push(
        `${refused.map((p) => p.kind).join(", ")} cannot be paid (why is below each): untick ${refused.length > 1 ? "them" : "it"} ` +
          "to pay the rest, or fix what stops it, then Check again"
      )
    }

    // Everything chosen, together: each payout's check counts only its own.
    const [balance, native, baseFee] = await Promise.all([chain.tokenBalance(), chain.nativeBalance(), chain.baseFee()])
    const due = payouts.reduce((sum, p) => sum.add(p.due), ZERO)
    const count = payouts.reduce((n, p) => n + p.toSend, 0)
    if (balance.lt(due)) problems.push(`${account} holds ${pnk(balance)}, less than the ${pnk(due)} to send`)
    const gasPerTransfer = BigNumber.from(envInt("SEND_GAS_LIMIT", 100000) || 100000).mul(
      (baseFee || utils.parseUnits("1", "gwei")).mul(2).add(utils.parseUnits("1", "gwei"))
    )
    if (native.lt(gasPerTransfer.mul(count))) {
      problems.push(
        `${account} holds ${utils.formatEther(native)} of the native token for gas, less than the ` +
          `${utils.formatEther(gasPerTransfer.mul(count))} its ${count} transfer(s) may use`
      )
    }
    if (count === 0 && problems.length === 0) notes.push("Nothing to send: every payout chosen is paid")

    this.plan =
      problems.length === 0 && count > 0
        ? { checkId: randomId(), account, payouts: planned, expectedNonce: latest, touchedAt: Date.now() }
        : null
    return {
      checkId: this.plan ? this.plan.checkId : null,
      folder: String(input.folder),
      account,
      chainId,
      token,
      nonce: latest,
      balance: balance.toString(),
      native: native.toString(),
      due: due.toString(),
      payouts,
      problems,
      notes,
      unsettled,
    }
  }

  private describeTransfers(record: DisbursementRecord): PlannedTransfer[] {
    return record.transfers.map((t, index) => ({
      index,
      recipient: t.recipient,
      amount: t.amount,
      status: t.status,
      ...(t.txHash ? { txHash: t.txHash, url: explorerTxUrl(record.chainId, t.txHash) } : {}),
    }))
  }

  // A record started from another account and never sent from: nothing of it
  // is on-chain, so it moves to the account paying now (an account selected
  // by mistake, the popup rejected, would otherwise bind the payout to it).
  private rebindUntouched(account: string, notes: string[]): void {
    const chainId = sendChainId()
    const token = sendTokenAddress().toLowerCase()
    for (const record of listDisbursements()) {
      if (record.chainId !== chainId || String(record.token).toLowerCase() !== token) continue
      if (record.status !== "in-progress" || record.from.toLowerCase() === account.toLowerCase()) continue
      if (!record.transfers.every(untouched)) continue
      const before = record.from
      record.from = account
      saveDisbursement(record)
      notes.push(`${displayPath(recordPath(record))}: started from ${before}, which never sent any of it: it is now ${account}'s to pay`)
    }
  }

  // What the dry run settled that the ledger must keep: a record with every
  // transfer paid is completed, and transfers found on-chain and recorded as
  // paid on the operator's word (the "record them as paid" option) are kept.
  private keepSettled(record: DisbursementRecord, skipPaidOnChain: boolean, notes: string[]): void {
    const onDisk = listDisbursements().find((r) => r.id === record.id)
    const changed = !onDisk || JSON.stringify(onDisk.transfers) !== JSON.stringify(record.transfers)
    const allPaid = record.transfers.every((t) => t.status === "confirmed")
    const found = skipPaidOnChain && record.transfers.some((t) => t.foundOnChain)
    if (allPaid && record.status !== "completed" && (onDisk || skipPaidOnChain)) {
      record.status = "completed"
      record.completedAt = new Date().toISOString()
      saveDisbursement(record)
      notes.push(`${record.kind}: every transfer is paid: recorded as disbursed in ${displayPath(recordPath(record))}`)
    } else if (changed && (onDisk || found)) {
      // the dry run's receipts (an earlier run's transactions, mined) or the
      // payments the operator said are this payout's
      saveDisbursement(record)
      notes.push(
        `${record.kind}: ${found ? "the transfers found on-chain are recorded as paid" : "brought up to date from the chain"} in ` +
          displayPath(recordPath(record))
      )
    }
  }

  // --- sending, one transfer at a time --------------------------------------

  private livePlan(checkId: string): Plan {
    const plan = this.plan
    if (!plan || plan.checkId !== checkId) throw new SendRefusedError("This check is no longer current: Check again")
    if (Date.now() - plan.touchedAt > PLAN_MINUTES * 60000) {
      this.plan = null
      throw new SendRefusedError(`The check is more than ${PLAN_MINUTES} minutes old: Check again`)
    }
    plan.touchedAt = Date.now()
    return plan
  }

  // The next transfer to hand to the wallet, recorded as handed before the
  // page gets it; or "done" once every chosen payout is paid.
  async next(input: { checkId: string }): Promise<Step> {
    const plan = this.livePlan(String(input.checkId))
    if (this.active) throw new SendRefusedError("A transfer is with the wallet already: wait until it is settled")
    const chain = this.chain(plan.account)
    for (const p of plan.payouts) {
      const index = p.record.transfers.findIndex((t) => t.status !== "confirmed")
      if (index < 0) {
        if (p.record.status !== "completed") {
          p.record.status = "completed"
          p.record.completedAt = new Date().toISOString()
          saveDisbursement(p.record)
        }
        continue
      }
      // The ledger's record is still the one checked: nothing else wrote it.
      const disk = listDisbursements().find((r) => r.id === p.record.id)
      if (disk && JSON.stringify(disk.transfers) !== JSON.stringify(p.record.transfers)) {
        this.plan = null
        throw new SendRefusedError(`${displayPath(recordPath(p.record))} changed since the check: Check again`)
      }
      const t = p.record.transfers[index]
      if (t.status !== "pending" && t.status !== "failed") {
        this.plan = null
        throw new SendRefusedError(`${t.recipient}'s transfer is ${t.status}, not ready to send: Check again`)
      }
      // Nothing of this account's since the check, but this page's own
      // transfers: another transaction (another tab, another app, the CLI)
      // could be a payment the check did not see.
      const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
      if (latest !== plan.expectedNonce || pending !== latest) {
        this.plan = null
        throw new SendRefusedError(
          `${plan.account} has sent or is sending a transaction this page did not (nonce ${latest}, ${pending - latest} pending; ` +
            `expected ${plan.expectedNonce}, none pending): Check again`
        )
      }
      const amount = BigNumber.from(t.amount)
      try {
        await chain.simulateTransfer(t.recipient, amount)
      } catch (err) {
        this.plan = null
        throw new SendRefusedError(`Not sending ${pnk(amount)} to ${t.recipient}: ${errorMessage(err)}`)
      }
      const block = await chain.blockNumber()
      const requestId = randomId()
      clearTransaction(t)
      t.status = "requested"
      t.viaWallet = true
      t.requestedAt = new Date().toISOString()
      t.requestedNonce = latest
      t.requestedBlock = block
      t.requestId = requestId
      p.record.status = "in-progress"
      // A record holding browser-wallet transfers: code older than the
      // disburse page refuses it rather than signing a "requested" one anew.
      p.record.version = 2
      saveDisbursement(p.record) // before the wallet is asked: from here on, the ledger knows
      const data = transferCalldata(t.recipient, amount)
      this.issued.set(requestId, { recordId: p.record.id, index, requestedNonce: latest, data })
      this.active = { requestId, payout: p, transfer: t, index, data, nonce: latest, verified: false }
      return {
        state: "send",
        requestId,
        kind: p.kind,
        index,
        recipient: t.recipient,
        amount: t.amount,
        tx: { from: plan.account, to: p.record.token, data, value: "0x0", chainId: hexQuantity(p.record.chainId) },
      }
    }
    const done = plan.payouts.map((p) => ({ kind: p.kind, ledger: displayPath(recordPath(p.record)), status: p.record.status }))
    this.plan = null
    return { state: "done", payouts: done }
  }

  // The ledger's record by id: the very copy a run holds when it uses that
  // record (saving a fresh read would be undone by the run's next save).
  private ledgerRecord(recordId: string): DisbursementRecord | undefined {
    const held = (this.active ? [this.active.payout.record] : []).concat(this.plan ? this.plan.payouts.map((p) => p.record) : [])
    return held.find((r) => r.id === recordId) || listDisbursements().find((r) => r.id === recordId)
  }

  private current(requestId: string): Active {
    const a = this.active
    if (!a || a.requestId !== String(requestId)) throw new SendRefusedError("No such transfer is with the wallet: Check again")
    return a
  }

  // The wallet answered a hash: kept at once, and the transfer's transaction
  // once the chain shows it is exactly the transfer. An answer for a transfer
  // handed out before the page reloaded (or by another tab) is kept too.
  async sent(input: { requestId: string; hash: string }): Promise<{ state: "sent" | "unverified"; hash: string; url: string | null }> {
    const hash = String(input.hash || "").toLowerCase()
    if (!HASH.test(hash)) throw new SendRefusedError(`"${input.hash}" is not a transaction hash`)
    const a = this.active && this.active.requestId === String(input.requestId) ? this.active : null
    if (!a) return this.lateAnswer(String(input.requestId), hash)
    if (a.hash && a.hash !== hash) throw new SendRefusedError(`The wallet answered ${a.hash} for this transfer already`)
    const record = a.payout.record
    const url = explorerTxUrl(record.chainId, hash)
    if (!a.hash) {
      a.hash = hash
      a.transfer.reportedTxHash = hash
      saveDisbursement(record)
    }
    if (a.verified) return { state: "sent", hash, url }
    const chain = this.chain(record.from)
    const tx = await chain.transactionDetails(hash)
    if (!tx) return { state: "unverified", hash, url } // the RPC has not seen it yet
    const wrong = transferMismatch(tx, { from: record.from, token: record.token, data: a.data, chainId: record.chainId, minNonce: a.nonce })
    if (wrong) {
      // Never recorded as the transfer's transaction; the transfer stays
      // "requested", for the next check to settle from the chain.
      this.active = null
      this.plan = null
      throw new SendRefusedError(
        `The wallet's transaction ${hash} is not the transfer it was asked for: ${wrong}. It is not recorded as its payment. ` +
          "Look at it on the explorer, then Check again: the check settles the transfer from the chain."
      )
    }
    a.verified = true
    a.transfer.status = "sent"
    a.transfer.txHash = hash
    a.transfer.nonce = tx.nonce
    a.transfer.attempts = [hash]
    delete a.transfer.reportedTxHash
    saveDisbursement(record)
    if (tx.nonce > a.nonce) {
      // Not the nonce it was handed out with: other transactions of the
      // account came first, sent since (a request approved late?) or held by
      // the wallet unknown to this node (one marked as never sent, sent after
      // all?). Either may be a payment the check did not see.
      this.active = null
      this.plan = null
      const latest = await chain.nonce("latest")
      throw new SendRefusedError(
        `The wallet sent it as ${hash} with nonce ${tx.nonce}, while the account's next nonce was ${a.nonce}: ` +
          (latest > a.nonce
            ? `${record.from} sent ${Math.min(latest, tx.nonce) - a.nonce} other transaction(s) since it was handed to the wallet (a request approved late?)`
            : `the wallet holds ${tx.nonce - a.nonce} earlier transaction(s) of ${record.from} that this node does not know (one marked as never sent, sent after all?)`) +
          ", mined before it. It is recorded as this transfer's transaction. Look at the wallet's activity before anything " +
          "else, then Check again."
      )
    }
    return { state: "sent", hash, url }
  }

  // An answer for a transfer that is no longer the one with the wallet (the
  // page reloaded, another tab checked): recorded on it all the same, so that
  // no hash the wallet gave is ever lost.
  private async lateAnswer(requestId: string, hash: string): Promise<never> {
    const issued = this.issued.get(requestId)
    if (!issued) throw new SendRefusedError("No such transfer was handed to the wallet: Check again")
    const record = this.ledgerRecord(issued.recordId)
    const t = record ? record.transfers[issued.index] : undefined
    if (!record || !t) throw new SendRefusedError("The transfer this answer is for is no longer in the ledger: look at it on the explorer")
    if (isRequested(t) && t.requestId === requestId && !t.reportedTxHash) {
      t.reportedTxHash = hash
      saveDisbursement(record)
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${pnk(t.amount)} to ${t.recipient}, after this page checked again: it is recorded. ` +
          "Check again: the check settles it from the chain."
      )
    }
    if (paidHashes(t).includes(hash)) {
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${pnk(t.amount)} to ${t.recipient} after this page checked again, which already ` +
          `settled the transfer from the chain (${t.status}, by this very transaction). Check again.`
      )
    }
    if (!(t.strayTxs || []).includes(hash)) {
      t.strayTxs = union(t.strayTxs, [hash])
      saveDisbursement(record)
    }
    // The run stops: the next check settles the transfer from the chain, and
    // says whether it was paid twice.
    this.plan = null
    if (t.status !== "confirmed") {
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${pnk(t.amount)} to ${t.recipient} for an earlier hand-out of it (the transfer is ` +
          `now ${t.status}): it is recorded on it. If both are sent, the recipient is paid twice: reject any request for it ` +
          "still open in the wallet, then Check again, which settles it from the chain."
      )
    }
    throw new SendRefusedError(
      `The wallet answered ${hash} for ${pnk(t.amount)} to ${t.recipient} late, after that transfer was settled (${t.status})` +
        `${t.requestId === requestId ? "" : ", for an earlier hand-out of it"}. It is recorded on it. Look it up on the ` +
        "explorer: if it is mined as well as the transfer's own payment, the recipient was paid twice (the next Check says " +
        "so), and the excess is to be recovered by hand."
    )
  }

  // Waits a little for the transfer's transaction to be mined.
  async receipt(input: { requestId: string }): Promise<Receipt> {
    const a = this.current(input.requestId)
    if (!a.verified || !a.hash) throw new SendRefusedError("The wallet's transaction is not known yet")
    const record = a.payout.record
    const chain = this.chain(record.from)
    const deadline = Date.now() + this.waitMs
    const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
    for (;;) {
      const outcome = await this.settleSent(chain, record, a.transfer)
      if (outcome.state === "confirmed") {
        this.active = null
        if (this.plan) {
          // the wallet used the nonce it was expected to: the next transfer may follow
          if (a.transfer.nonce === a.nonce) this.plan.expectedNonce = a.nonce + 1
          else this.plan = null
        }
        return outcome
      }
      if (outcome.state !== "pending") {
        this.active = null
        this.plan = null
        return outcome
      }
      if (Date.now() >= deadline) return outcome
      await sleep(pollMs)
    }
  }

  // The wallet answered that the operator rejected it: nothing was sent, if
  // the account's nonces agree; otherwise the next check settles it.
  async rejected(input: { requestId: string }): Promise<{ state: "cleared" | "unsettled"; message: string }> {
    const a = this.current(input.requestId)
    this.active = null
    const record = a.payout.record
    if (a.hash) {
      this.plan = null
      return { state: "unsettled", message: "The wallet answered a hash for it before: Check again to settle it" }
    }
    const chain = this.chain(record.from)
    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (latest === a.nonce && pending === latest) {
      clearTransaction(a.transfer)
      a.transfer.status = "pending"
      saveDisbursement(record)
      return { state: "cleared", message: "Rejected in the wallet: nothing was sent" }
    }
    this.plan = null
    return {
      state: "unsettled",
      message: "The account's nonce moved since the transfer was handed to the wallet: Check again, which settles it from the chain",
    }
  }

  // The wallet failed without saying whether it sent it: left for the next
  // check to settle from the chain.
  async failed(input: { requestId: string; message?: string }): Promise<{ state: "unsettled"; message: string }> {
    const a = this.current(input.requestId)
    this.active = null
    this.plan = null
    return {
      state: "unsettled",
      message:
        `The wallet answered "${String(input.message || "an error")}", which does not say whether it sent ` +
        `${pnk(a.transfer.amount)} to ${a.transfer.recipient}. Look at the wallet's activity, then Check again: the check settles it from the chain.`,
    }
  }

  // --- settling what the chain does not settle on its own -----------------

  private walletTransfer(recordId: string, index: number): { record: DisbursementRecord; t: LedgerTransfer } {
    const record = this.ledgerRecord(String(recordId))
    if (!record) throw new SendRefusedError("No such payout in the ledger")
    const t = record.transfers[Number(index)]
    if (!t || !(isRequested(t) || (t.viaWallet && t.status === "sent"))) {
      throw new SendRefusedError("That transfer is not one handed to a wallet and waiting to be settled")
    }
    if (this.active && this.active.payout.record.id === record.id && this.active.index === Number(index)) {
      throw new SendRefusedError("That transfer is with the wallet right now: answer it there first")
    }
    return { record, t }
  }

  // The operator gives the hash the wallet's activity shows for a transfer.
  async recordHash(input: { recordId: string; index: number; hash: string }): Promise<{ state: string; message: string }> {
    const { record, t } = this.walletTransfer(input.recordId, input.index)
    const hash = String(input.hash || "").toLowerCase()
    if (!HASH.test(hash)) throw new SendRefusedError(`"${input.hash}" is not a transaction hash`)
    const chain = this.chain(record.from)
    const tx = await chain.transactionDetails(hash)
    if (!tx) throw new SendRefusedError(`The RPC does not know ${hash}: check the hash, or wait until the transaction spreads`)
    const wrong = transferMismatch(tx, {
      from: record.from,
      token: record.token,
      data: transferCalldata(t.recipient, BigNumber.from(t.amount)),
      chainId: record.chainId,
      minNonce: t.requestedNonce,
    })
    if (wrong) throw new SendRefusedError(`${hash} is not this transfer: ${wrong}`)
    if (ledgerHashesBut(record.id, Number(input.index)).has(hash)) {
      throw new SendRefusedError(`${hash} already pays another transfer of the ledger`)
    }
    // What the wallet answered for it, if another hash: taken over only once
    // the chain shows it cannot pay the transfer unseen.
    let stray: string | null = null
    const reported = t.reportedTxHash ? t.reportedTxHash.toLowerCase() : null
    if (reported && reported !== hash) {
      const answered = await chain.transactionDetails(reported)
      const data = transferCalldata(t.recipient, BigNumber.from(t.amount))
      const answeredWrong = answered
        ? transferMismatch(answered, { from: record.from, token: record.token, data, chainId: record.chainId, minNonce: t.requestedNonce })
        : ""
      if (answered && !answeredWrong) throw new SendRefusedError(`The wallet answered ${reported} for it, which is this transfer: Check again, which settles it`)
      if (answered && answered.blockNumber === null) {
        throw new SendRefusedError(`The wallet answered ${reported} for it, which is not mined yet: wait until it is, then decide`)
      }
      if (!answered && tx.blockNumber === null) {
        throw new SendRefusedError(
          `The wallet answered ${reported} for it, which the RPC does not know: ${hash} is taken for it once mined (wait for it), ` +
            `when no other transaction of the account can still use its nonce`
        )
      }
      stray = reported
    }
    const payment = await this.paymentSince(chain, record, t, hash)
    if (payment) {
      throw new SendRefusedError(
        `${payment.txHash} (block ${payment.blockNumber}) already pays it: Check again, which records it.` +
          (tx.blockNumber !== null ? ` ${hash} is mined too: the recipient was paid twice.` : "")
      )
    }
    if (t.status === "sent" && t.nonce !== undefined && tx.nonce !== t.nonce) {
      // Another nonce than its transaction's: only once that one can no
      // longer be mined (its nonce taken), or both could pay.
      if ((await chain.nonce("latest")) <= t.nonce) {
        throw new SendRefusedError(
          `${hash} has nonce ${tx.nonce}, and the transfer's transaction ${t.txHash} (nonce ${t.nonce}) may still be mined: ` +
            "wait for it, or cancel it in the wallet, then give the hash again"
        )
      }
      t.forgottenTxs = union(t.forgottenTxs, paidHashes(t))
      t.attempts = []
    }
    t.status = "sent"
    t.viaWallet = true
    t.txHash = hash
    t.nonce = tx.nonce
    t.attempts = union(t.attempts, [hash])
    if (stray) t.strayTxs = union(t.strayTxs, [stray])
    delete t.reportedTxHash
    saveDisbursement(record)
    const outcome = await this.settleSent(chain, record, t)
    this.plan = null
    return { state: outcome.state, message: `Recorded ${hash} as the transfer's transaction (${outcome.state}). Check again.` }
  }

  // The operator says the wallet never sent it, or that its transaction is
  // gone. Taken only when the chain cannot contradict it: nothing of the
  // account's pending, no payment of it since it was handed out, its own
  // transaction (if any) unknown to the node or past mining (its nonce used by
  // another), and a hash the wallet answered for it either mined as another
  // transaction, or unknown to the node with the account's nonce moved on.
  async forget(input: { recordId: string; index: number }): Promise<{ state: "cleared"; message: string }> {
    const { record, t } = this.walletTransfer(input.recordId, input.index)
    const chain = this.chain(record.from)
    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (pending > latest) throw new SendRefusedError(`${record.from} has a transaction pending: wait until it is mined, then decide`)
    // The wallet answered a hash for it: only once the chain shows that hash
    // is not the transfer, or it never arrived and the nonce moved on.
    let stray: string | null = null
    if (t.reportedTxHash) {
      const reported = t.reportedTxHash
      const tx = await chain.transactionDetails(reported)
      const data = transferCalldata(t.recipient, BigNumber.from(t.amount))
      const wrong = tx ? transferMismatch(tx, { from: record.from, token: record.token, data, chainId: record.chainId, minNonce: t.requestedNonce }) : ""
      if (tx && !wrong) throw new SendRefusedError(`The wallet answered ${reported} for it, which is this transfer: Check again, which settles it`)
      if (tx && tx.blockNumber === null) {
        throw new SendRefusedError(`The wallet answered ${reported} for it, which is not mined yet: wait until it is, then decide`)
      }
      if (!tx && latest <= Number(t.requestedNonce)) {
        throw new SendRefusedError(
          `The wallet answered ${reported} for it, which the RPC does not know, and the account has sent nothing since: it may ` +
            "still be sent. If the wallet shows it pending, speed it up or cancel it there, then Check."
        )
      }
      if (tx) stray = reported // mined, and another transaction than the transfer
    }
    const payment = await this.paymentSince(chain, record, t)
    if (payment) {
      throw new SendRefusedError(
        `Not forgetting it: ${payment.txHash} (block ${payment.blockNumber}) pays ${t.recipient} exactly this amount since the ` +
          "transfer was handed to the wallet. Check again: the check records it."
      )
    }
    const own = paidHashes(t).concat(t.reportedTxHash && !stray ? [t.reportedTxHash.toLowerCase()] : [])
    if (t.status === "sent" && t.nonce !== undefined && latest <= t.nonce) {
      // Signed and broadcast, its nonce still free: a node or the wallet may
      // still send it, however long it has been gone from this one.
      throw new SendRefusedError(
        `Its transaction ${t.txHash} (nonce ${t.nonce}) is not mined, and nonce ${t.nonce} is still free: a node, or the wallet, ` +
          `may still send it. Use that nonce first: cancel it in the wallet, or send any transaction from ${record.from} with ` +
          `nonce ${t.nonce} (a 0-value one to itself). Then Check again: once the chain shows nothing pays the transfer, it can ` +
          "be marked as never sent."
      )
    }
    if (own.length > 0) t.forgottenTxs = union(t.forgottenTxs, own)
    if (stray) t.strayTxs = union(t.strayTxs, [stray])
    clearTransaction(t)
    t.status = "pending"
    saveDisbursement(record)
    this.plan = null
    return { state: "cleared", message: `${t.recipient}'s transfer is marked as never sent: Check again to send it` }
  }

  // A payment of the transfer from the payout's account, mined since the
  // transfer was handed to the wallet: one of its own transactions (found in
  // the Transfer logs, the receipt lagging or gone), or one the ledger does
  // not know with a nonce from the one it was handed out with (the wallet's
  // replacement, or a request approved late).
  private async paymentSince(
    chain: SendChain,
    record: DisbursementRecord,
    t: LedgerTransfer,
    except?: string
  ): Promise<{ txHash: string; blockNumber: number; nonce: number | null; own: boolean } | null> {
    // From the chain's block when it was handed out, in the chain's own time
    // (this machine's clock may run ahead of the blocks' timestamps).
    const fromBlock = t.requestedBlock !== undefined ? t.requestedBlock : record.startBlock
    const blockTime = fromBlock !== undefined ? await chain.blockTimestamp(fromBlock) : null
    const sinceUnix = blockTime !== null ? blockTime : Math.floor(Date.parse(String(t.requestedAt || record.createdAt)) / 1000) - 86400
    const own = ownHashes(t)
    const others = ledgerHashesBut(record.id, record.transfers.indexOf(t))
    const found = (await chain.outgoingTransfers(sinceUnix)).filter(
      (f) =>
        f.to.toLowerCase() === t.recipient.toLowerCase() &&
        f.amount === t.amount &&
        f.txHash.toLowerCase() !== String(except || "").toLowerCase() &&
        (own.has(f.txHash.toLowerCase()) || !others.has(f.txHash.toLowerCase())) &&
        (fromBlock === undefined || f.blockNumber >= fromBlock)
    )
    const mine = found.find((f) => own.has(f.txHash.toLowerCase()))
    if (mine) return { txHash: mine.txHash.toLowerCase(), blockNumber: mine.blockNumber, nonce: t.nonce === undefined ? null : t.nonce, own: true }
    for (const f of found) {
      const tx = await chain.transactionDetails(f.txHash)
      if (tx) {
        if (tx.from.toLowerCase() === record.from.toLowerCase() && (t.requestedNonce === undefined || tx.nonce >= t.requestedNonce)) {
          return { txHash: f.txHash.toLowerCase(), blockNumber: f.blockNumber, nonce: tx.nonce, own: false }
        }
        continue
      }
      // The RPC does not return the transaction, but its Transfer log is the
      // account's: mined in a later block than the hand-out, it came after it.
      if (fromBlock === undefined || f.blockNumber > fromBlock) {
        return { txHash: f.txHash.toLowerCase(), blockNumber: f.blockNumber, nonce: null, own: false }
      }
    }
    return null
  }

  // A transfer whose wallet transaction is known: mined, reverted, still
  // pending, or no longer able to be mined (its nonce taken): then paid by the
  // wallet's replacement (sped up), or left to the operator (cancelled?).
  private async settleSent(chain: SendChain, record: DisbursementRecord, t: LedgerTransfer): Promise<Receipt> {
    const hash = String(t.txHash)
    const settled = (): Receipt | null => {
      if (t.status === "confirmed") {
        return { state: "confirmed", hash: String(t.txHash), block: Number(t.blockNumber), url: explorerTxUrl(record.chainId, String(t.txHash)) }
      }
      if (t.status === "failed") {
        return { state: "reverted", hash, message: `${hash} reverted: nothing was paid by it. Check again to send the transfer anew.` }
      }
      return null
    }
    if ((await settle(chain, t)) !== "pending") {
      saveDisbursement(record)
      return settled() as Receipt
    }
    const latest = await chain.nonce("latest")
    if (t.nonce === undefined || latest <= t.nonce) return { state: "pending", hash }
    // Its nonce is used: most likely by this very transaction, its receipt not
    // served yet (read a moment before the nonce, or a node behind another).
    const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
    for (let tries = 0; tries < 3; tries++) {
      await sleep(pollMs)
      if ((await settle(chain, t)) !== "pending") {
        saveDisbursement(record)
        return settled() as Receipt
      }
    }
    // The account's Transfer logs: its own transaction (the receipt gone), or
    // the wallet's replacement of it.
    const payment = await this.paymentSince(chain, record, t)
    if (payment && (payment.own || payment.nonce === t.nonce)) {
      t.status = "confirmed"
      if (!payment.own) t.attempts = (t.attempts || []).concat(payment.txHash)
      t.txHash = payment.txHash
      t.blockNumber = payment.blockNumber
      t.confirmedAt = new Date().toISOString()
      delete t.reportedTxHash
      saveDisbursement(record)
      return {
        state: "confirmed",
        hash: payment.txHash,
        block: payment.blockNumber,
        url: explorerTxUrl(record.chainId, payment.txHash),
        ...(payment.own ? {} : { note: `paid by ${payment.txHash}, the wallet's replacement of ${hash} (sped up)` }),
      }
    }
    if (payment) {
      return {
        state: "stopped",
        message:
          `${hash} can no longer be mined (nonce ${t.nonce} went to another transaction), and ${payment.txHash} pays ` +
          `${t.recipient} the same amount with ${payment.nonce === null ? "a nonce the RPC does not return" : `nonce ${payment.nonce}`}: ` +
          "give that hash for it on the page if it is this transfer's.",
      }
    }
    return {
      state: "stopped",
      message:
        `${hash} can no longer be mined: its nonce went to another transaction, and nothing pays the transfer (cancelled in the ` +
        "wallet?). Check: once you confirm there it was never sent, it is sent anew.",
    }
  }

  // Before a check: every transfer of this chain and token handed to a wallet
  // and not settled, settled from the chain when it tells (mined, still
  // pending), or listed for the operator with what they may do.
  private async settleWalletTransfers(chain: SendChain, account: string, notes: string[]): Promise<UnsettledTransfer[]> {
    const chainId = sendChainId()
    const token = sendTokenAddress().toLowerCase()
    const out: UnsettledTransfer[] = []
    for (const record of listDisbursements()) {
      if (record.chainId !== chainId || String(record.token).toLowerCase() !== token) continue
      for (const [index, t] of record.transfers.entries()) {
        const sentByWallet = !!t.viaWallet && t.status === "sent"
        if (!isRequested(t) && !sentByWallet) continue
        const ledger = displayPath(recordPath(record))
        const entry = {
          ledger,
          recordId: record.id,
          index,
          recipient: t.recipient,
          amount: t.amount,
          from: record.from,
          requestedAt: t.requestedAt,
          requestedNonce: t.requestedNonce,
        }
        const label = `${pnk(t.amount)} to ${t.recipient} (${record.kind} ${periodLabel(record.periodStart, record.periodEnd)}, ${ledger})`
        const leave = (why: string, actions: ("hash" | "forget")[]) => out.push({ ...entry, actions, why: `${label}: ${why}` })
        if (record.from.toLowerCase() !== account.toLowerCase()) {
          leave(`handed to the wallet of ${record.from}, not settled: select that account in the wallet and Check, to settle it`, [])
          continue
        }
        if (isRequested(t) && t.reportedTxHash) {
          const tx = await chain.transactionDetails(t.reportedTxHash)
          const data = transferCalldata(t.recipient, BigNumber.from(t.amount))
          if (tx && !transferMismatch(tx, { from: record.from, token: record.token, data, chainId: record.chainId, minNonce: t.requestedNonce })) {
            t.status = "sent"
            t.txHash = t.reportedTxHash
            t.nonce = tx.nonce
            t.attempts = [t.reportedTxHash]
            delete t.reportedTxHash
            saveDisbursement(record)
          } else {
            const payment = await this.paymentSince(chain, record, t)
            if (payment) {
              this.recordPayment(record, t, payment)
              notes.push(`${label}: paid in block ${payment.blockNumber} (${payment.txHash})`)
              continue
            }
            const reported = t.reportedTxHash
            const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
            if (tx && tx.blockNumber === null) {
              leave(`the wallet answered ${reported} for it, which is not this transfer and is not mined yet: wait until it is, then Check again`, [])
            } else if (tx) {
              leave(
                `the wallet answered ${reported} for it, mined in block ${tx.blockNumber}, which is not this transfer ` +
                  `(${transferMismatch(tx, { from: record.from, token: record.token, data, chainId: record.chainId, minNonce: t.requestedNonce })}), ` +
                  "and nothing pays the transfer. If the wallet's activity shows another hash for it, give that one; otherwise mark it as never sent.",
                ["hash", "forget"]
              )
            } else if (pending > latest || latest <= Number(t.requestedNonce)) {
              leave(
                `the wallet answered ${reported} for it, which the RPC does not know. If the wallet shows it pending, speed it up or ` +
                  "cancel it there, then Check again. If the wallet's activity shows another hash for it, give that one. If it " +
                  `shows nothing, use nonce ${t.requestedNonce}: send any transaction from ${record.from} (a 0-value one to itself); ` +
                  "once nothing pays the transfer, it can be marked as never sent.",
                ["hash"]
              )
            } else {
              leave(
                `the wallet answered ${reported} for it, which the RPC does not know, and the account has sent ` +
                  `${latest - Number(t.requestedNonce)} transaction(s) since, none of which pays it. If the wallet's activity shows ` +
                  "another hash for it, give that one; if it shows none, mark it as never sent.",
                ["hash", "forget"]
              )
            }
            continue
          }
        }
        if (t.status === "sent") {
          const outcome = await this.settleSent(chain, record, t)
          if (outcome.state === "confirmed") notes.push(`${label}: paid in block ${outcome.block} (${outcome.hash})`)
          else if (outcome.state === "reverted") notes.push(`${label}: ${outcome.message}`)
          else if (outcome.state === "pending") {
            const known = await chain.transactionDetails(outcome.hash)
            leave(
              known
                ? `its transaction ${outcome.hash} is not mined yet: wait for it (or speed it up in the wallet), then Check again`
                : `its transaction ${outcome.hash} is not mined, and the RPC no longer knows it (dropped?), but its nonce ` +
                    `${t.nonce} is free, so it may still be sent. If the wallet shows another transaction for it (sped up), give ` +
                    `that one's hash. Otherwise cancel it in the wallet, or send any transaction from ${record.from} with nonce ` +
                    `${t.nonce} (a 0-value one to itself), then Check again: it can then be marked as never sent.`,
              known ? [] : ["hash"]
            )
          } else leave(outcome.message, ["hash", "forget"])
          continue
        }
        // "requested", no answer kept: the wallet's answer was lost, or never came
        const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
        if (pending > latest) {
          leave(`${record.from} has a transaction pending, maybe this one: wait until it is mined, then Check again`, [])
          continue
        }
        const payment = latest > Number(t.requestedNonce) ? await this.paymentSince(chain, record, t) : null
        if (payment) {
          this.recordPayment(record, t, payment)
          notes.push(`${label}: the wallet sent it, ${payment.txHash}, mined in block ${payment.blockNumber}`)
          continue
        }
        leave(
          latest === Number(t.requestedNonce)
            ? `handed to the wallet on ${String(t.requestedAt).slice(0, 19)}Z, and the account has sent nothing since. If the wallet ` +
                "still shows that request, reject it there; then mark it as never sent."
            : `handed to the wallet on ${String(t.requestedAt).slice(0, 19)}Z with nonce ${t.requestedNonce}; the account has sent ` +
                `${latest - Number(t.requestedNonce)} transaction(s) since, none of which pays it. Look at the wallet's activity: ` +
                "give the transfer's hash if it was sent, or mark it as never sent.",
          ["hash", "forget"]
        )
      }
    }
    return out
  }

  // A transfer paid through a wallet and then paid again by another
  // transaction of the account (same recipient, same amount, after it was
  // handed out, unknown to the ledger): a request approved late, or a
  // transaction marked never sent and sent after all. Recorded on it
  // (`paidTwiceBy`), and a problem of the check that finds it.
  private async findRepeats(chain: SendChain, account: string, problems: string[], notes: string[]): Promise<void> {
    const chainId = sendChainId()
    const token = sendTokenAddress().toLowerCase()
    const records = listDisbursements()
    const watched: { record: DisbursementRecord; t: LedgerTransfer }[] = []
    for (const record of records) {
      if (record.chainId !== chainId || String(record.token).toLowerCase() !== token) continue
      if (record.from.toLowerCase() !== account.toLowerCase()) continue
      for (const t of record.transfers) {
        if (t.status !== "confirmed" || !t.viaWallet || t.requestedBlock === undefined) continue
        if (Date.now() - Date.parse(String(t.requestedAt)) > REPEAT_DAYS * 86400000) continue
        watched.push({ record, t })
      }
    }
    if (watched.length === 0) return
    let out: { to: string; amount: string; txHash: string; blockNumber: number }[]
    try {
      const since = await chain.blockTimestamp(Math.min(...watched.map((w) => Number(w.t.requestedBlock))))
      if (since === null) throw new Error("the RPC did not return the block the oldest of them was handed out in")
      out = await chain.outgoingTransfers(since)
    } catch (err) {
      notes.push(`Could not look for transfers paid twice (${errorMessage(err)}): Check again to retry`)
      return
    }
    const paid = new Set(records.flatMap((r) => r.transfers.flatMap(paidHashes)))
    for (const { record, t } of watched) {
      const known = new Set((t.paidTwiceBy || []).map((h) => h.toLowerCase()))
      const again = out.filter(
        (f) =>
          f.to.toLowerCase() === t.recipient.toLowerCase() &&
          f.amount === t.amount &&
          f.blockNumber > Number(t.requestedBlock) &&
          !paid.has(f.txHash.toLowerCase()) &&
          !known.has(f.txHash.toLowerCase())
      )
      if (again.length === 0) continue
      t.paidTwiceBy = union(t.paidTwiceBy, again.map((f) => f.txHash))
      saveDisbursement(record)
      problems.push(
        `${pnk(t.amount)} to ${t.recipient} (${record.kind} ${periodLabel(record.periodStart, record.periodEnd)}) was paid ` +
          `again by ${again.map((f) => `${f.txHash} (block ${f.blockNumber})`).join(", ")}, after its payment ${t.txHash}: ` +
          "the recipient was paid twice (a request approved late, or a transaction marked never sent and sent after all). " +
          `Recover the excess by hand. It is recorded in ${displayPath(recordPath(record))} (paidTwiceBy); Check again to go on.`
      )
    }
  }

  private recordPayment(record: DisbursementRecord, t: LedgerTransfer, payment: { txHash: string; blockNumber: number; nonce: number | null }): void {
    const reported = t.reportedTxHash
    const { requestedAt, requestedNonce, requestedBlock, requestId } = t
    clearTransaction(t)
    Object.assign(t, { requestedAt, requestedNonce, requestedBlock, requestId })
    t.status = "confirmed"
    t.viaWallet = true
    t.txHash = payment.txHash
    if (payment.nonce !== null) t.nonce = payment.nonce
    t.attempts = [payment.txHash]
    // what the wallet answered, when it is not the payment: kept as evidence
    if (reported && reported.toLowerCase() !== payment.txHash.toLowerCase()) t.strayTxs = union(t.strayTxs, [reported])
    t.blockNumber = payment.blockNumber
    t.confirmedAt = new Date().toISOString()
    saveDisbursement(record)
  }
}

