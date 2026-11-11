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
  approveCalldata,
  createSendChain,
  decodeApproval,
  DISPERSE_ADDRESS,
  DISPERSE_CODE_HASH,
  disperseCalldata,
  explorerTxUrl,
  SendChain,
  sendChainId,
  sendTokenAddress,
  TransactionDetails,
  transferCalldata,
} from "../utils/send-chain"
import { FolderPayout, folderPayouts, listPayoutFolders, PAYOUT_KINDS, PayoutFolder, resolvePayoutFolder } from "./folders"

// What the disburse page does on this machine (server.ts serves it). The page
// only relays: it asks for a check, then for what to hand the browser wallet
// next, and reports what the wallet answered. Every decision is taken here,
// with send's own checks and ledger. What a check plans is paid one of two
// ways:
//
// - "disperse": every transfer in one transaction, through Disperse
//   (disperse.app's contract, checked by its code hash): the wallet approves
//   Disperse for exactly the total, unless it already allows that much, then
//   sends disperseTokenSimple, which moves each amount from the account to its
//   recipient, all or none. Two confirmations, or one.
// - "transfers": one transaction per transfer, each a plain transfer the
//   wallet shows with its recipient and amount.
//
// Either way:
// - a check is send's dry run as the wallet's account, for each payout of the
//   chosen folder: every refusal of `--mode send` applies (a payout already
//   disbursed, another file for a month already paid, transfers found on-chain
//   from this wallet or any other, the period not over, the funds), plus none
//   of the account's transactions pending;
// - the transfers a transaction pays are recorded as handed to the wallet
//   ("requested", with the account's next nonce and the chain's block) before
//   the wallet is asked, only while the account has sent nothing since the
//   check but this page's own transactions, and only once it succeeds
//   simulated (eth_call);
// - the hash the wallet answers is recorded at once, whenever it comes (a
//   late answer, after a reload or from another tab, too), and the
//   transaction is only taken for those transfers once the chain shows it is
//   exactly what was asked: from the account, to PNK (or Disperse), with the
//   calldata built here, no value;
// - transfers are only ever settled from the chain: mined (their own
//   transaction, or the wallet's replacement of it, found by receipt or in the
//   account's Transfer logs), or still pending. When the chain cannot say (the
//   wallet never answered, or its transaction can no longer be mined and
//   nothing pays it), the operator decides, by the hash from the wallet's
//   activity or by "never sent", which is refused whenever the chain could
//   still contradict it. Nothing is ever forgotten on its own, nothing is sent
//   twice, and a Disperse batch is settled, and decided on, as one.

const ZERO = BigNumber.from(0)
const pnk = (wei: BigNumber | string): string => `${humanizeAmount(BigNumber.from(wei))} PNK`
// To the last wei, as the page's rows and a wallet show an amount
// ("331,421.861696305094283609 PNK", "500 PNK"): for what the operator holds
// against the wallet, and for two amounts told apart.
const pnkExact = (wei: BigNumber | string): string => {
  const [whole, fraction] = utils.formatUnits(BigNumber.from(wei), 18).split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return (fraction && fraction !== "0" ? `${grouped}.${fraction}` : grouped) + " PNK"
}
const hexQuantity = (n: number): string => `0x${n.toString(16)}`
const PLAN_MINUTES = 30
const HASH = /^0x[0-9a-f]{64}$/
// How long after a transfer was handed to a wallet a second payment of it is
// looked for, at each check.
const REPEAT_DAYS = 45
// The most transfers one Disperse transaction pays here (~30k gas each, far
// below a Gnosis block).
export const MAX_BATCH = 150
// send's refusals name its flags; the page has two of them.
const PAGE_OPTIONS =
  "\n(On this page, --unrelated-tx, --skip-paid-on-chain and --paid-tx are the options under \"Transfers the check finds " +
  "already on-chain\"; --skip-onchain-check is only in yarn start --mode send.)"
// A transaction hash, or a hash and a recipient (one transfer of a batch).
const NAMED = /^0x[0-9a-f]{64}(:0x[0-9a-f]{40})?$/

export type PayMode = "transfers" | "disperse"

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

// What a wallet was handed that the chain does not settle on its own: one
// transfer, or a Disperse batch (`batch`: how many transfers, `total`).
// `actions`: what the operator may do from the page ("hash": give the hash
// the wallet's activity shows; "forget": say it was never sent).
export interface UnsettledTransfer {
  ledger: string
  recordId: string
  index: number
  recipient: string
  amount: string
  from: string
  requestedAt?: string
  requestedNonce?: number
  batch?: number
  total?: string
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
  mode: PayMode
  // Disperse mode: its address, what the account allows it now, and how many
  // confirmations the run takes (the approval, then the batch; or the batch).
  disperse: { address: string; allowance: string; confirmations: number } | null
  payouts: PlannedPayout[]
  problems: string[] // what stops everything
  notes: string[]
  unsettled: UnsettledTransfer[]
}

export interface StepTransfer {
  kind: DisbursementKind
  index: number
  recipient: string
  amount: string
}

export type Step =
  | { state: "send"; requestId: string; kind: DisbursementKind; index: number; recipient: string; amount: string; tx: Tx }
  | { state: "approve"; requestId: string; spender: string; amount: string; tx: Tx }
  | { state: "disperse"; requestId: string; transfers: StepTransfer[]; total: string; tx: Tx }
  | { state: "done"; payouts: { kind: DisbursementKind; ledger: string; status: string }[] }

export type Receipt =
  | { state: "pending"; hash: string }
  | { state: "confirmed"; hash: string; block: number; url: string | null; note?: string }
  | { state: "reverted"; hash: string; message: string }
  | { state: "stopped"; message: string }

// A batch settled from the chain (`found`: by its Transfer logs, its answer
// lost), or left open: to wait for, or for the operator to decide.
type BatchOutcome =
  | { state: "confirmed"; hash: string; block: number; url: string | null; note?: string; found: boolean }
  | { state: "reverted"; hash: string; message: string }
  | { state: "open"; wait: boolean; hash?: string; message: string; actions: ("hash" | "forget")[] }

interface PlanPayout {
  kind: DisbursementKind
  file: string
  record: DisbursementRecord
}

interface Plan {
  checkId: string
  account: string
  mode: PayMode
  payouts: PlanPayout[]
  expectedNonce: number // the account's next nonce: anything else it sends voids the plan
  approved?: string // what this run's approval allowed Disperse, once mined: the batch's total
  touchedAt: number
}

// A transfer of the ledger, in the record object that holds it.
interface Member {
  record: DisbursementRecord
  kind: DisbursementKind
  index: number
  t: LedgerTransfer
}

// What the chain must show a transaction is, to be taken for its transfers.
interface Expected {
  to: string
  toName: string
  data: string
  what: string
}

// What was handed to the wallet, by the id the page got for it. Kept for the
// server's life: an answer for it is recorded whenever it comes.
interface Issued {
  kind: "transfer" | "approve" | "disperse"
  members: { recordId: string; index: number }[]
}

// What is with the wallet in the run going on now.
interface Active {
  requestId: string
  kind: "transfer" | "approve" | "disperse"
  account: string
  members: Member[] // the transfers it pays: one, a batch, or none (an approval)
  expected: Expected
  amount: BigNumber // an approval's: what Disperse must be allowed
  nonce: number // the account's next nonce when it was handed to the wallet
  hash?: string
  txNonce?: number
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

// Why a transaction is not exactly the one expected, or "".
export const transferMismatch = (
  tx: TransactionDetails,
  expected: Expected & { from: string; chainId: number; minNonce?: number }
): string => {
  if (tx.from.toLowerCase() !== expected.from.toLowerCase()) return `it is from ${tx.from}, not ${expected.from}`
  if (!tx.to || tx.to.toLowerCase() !== expected.to.toLowerCase()) return `it is to ${tx.to}, not ${expected.toName} (${expected.to})`
  if (tx.input.toLowerCase() !== expected.data.toLowerCase()) return `its data is not ${expected.what}`
  if (!tx.value.isZero()) return `it carries ${utils.formatEther(tx.value)} of the native token`
  if (tx.chainId !== null && tx.chainId !== expected.chainId) return `it is for chain ${tx.chainId}, not ${expected.chainId}`
  if (expected.minNonce !== undefined && tx.nonce < expected.minNonce) {
    return `its nonce ${tx.nonce} was used before it was handed to the wallet (nonce ${expected.minNonce})`
  }
  return ""
}

// Why a transaction is not an approval of Disperse from the account, or "".
// Its amount is not held against the one asked (a wallet lets it be edited):
// what Disperse is allowed once it is mined is what counts.
const approvalMismatch = (tx: TransactionDetails, from: string, token: string, chainId: number, minNonce: number): string => {
  if (tx.from.toLowerCase() !== from.toLowerCase()) return `it is from ${tx.from}, not ${from}`
  if (!tx.to || tx.to.toLowerCase() !== token.toLowerCase()) return `it is to ${tx.to}, not PNK (${token})`
  const approval = decodeApproval(tx.input)
  if (!approval) return "it is not approve(spender, amount)"
  if (approval.spender.toLowerCase() !== DISPERSE_ADDRESS.toLowerCase()) return `it approves ${approval.spender}, not Disperse (${DISPERSE_ADDRESS})`
  if (!tx.value.isZero()) return `it carries ${utils.formatEther(tx.value)} of the native token`
  if (tx.chainId !== null && tx.chainId !== chainId) return `it is for chain ${tx.chainId}, not ${chainId}`
  if (tx.nonce < minNonce) return `its nonce ${tx.nonce} was used before it was handed to the wallet (nonce ${minNonce})`
  return ""
}

// The transaction that pays these transfers: a transfer, or their Disperse batch.
const expectedFor = (members: Member[]): Expected => {
  const first = members[0]
  if (!first.t.batch) {
    return {
      to: first.record.token,
      toName: "PNK",
      data: transferCalldata(first.t.recipient, BigNumber.from(first.t.amount)),
      what: "transfer(recipient, amount) of this transfer",
    }
  }
  return {
    to: DISPERSE_ADDRESS,
    toName: "Disperse",
    data: disperseCalldata(first.record.token, members.map((m) => m.t)),
    what: `disperseTokenSimple of this batch's ${members.length} transfers`,
  }
}

const sumOf = (members: Member[]): BigNumber => members.reduce((sum, m) => sum.add(m.t.amount), ZERO)

// What these transfers are, in a sentence.
const describeMembers = (members: Member[]): string => {
  const first = members[0]
  const ledger = displayPath(recordPath(first.record))
  if (members.length === 1 && !first.t.batch) {
    return `${pnk(first.t.amount)} to ${first.t.recipient} (${first.kind} ${periodLabel(first.record.periodStart, first.record.periodEnd)}, ${ledger})`
  }
  const kinds = Array.from(new Set(members.map((m) => m.kind))).join(", ")
  return `the Disperse batch of ${members.length} transfers, ${pnk(sumOf(members))} (${kinds} ${periodLabel(first.record.periodStart, first.record.periodEnd)})`
}

const saveAll = (members: Member[]): void => {
  for (const record of Array.from(new Set(members.map((m) => m.record)))) saveDisbursement(record)
}

// The wallet answered something for it: a hash, a transaction.
const answered = (t: LedgerTransfer): boolean => !!(t.reportedTxHash || t.txHash || (t.attempts || []).length)

const paidHashes = (t: LedgerTransfer): string[] =>
  (t.attempts || []).concat(t.txHash ? [t.txHash] : []).map((h) => h.toLowerCase())

// Every hash that may be this transfer's own transaction.
const ownHashes = (t: LedgerTransfer): Set<string> =>
  new Set(paidHashes(t).concat(t.reportedTxHash ? [t.reportedTxHash.toLowerCase()] : []))

// Every hash the ledger holds as paying a transfer, but this one's (the
// record's transfer at `index`) and its batch's (`requestId`): records are
// read anew from disk each time.
const ledgerHashesBut = (recordId: string, index: number, requestId?: string): Set<string> =>
  new Set(
    listDisbursements().flatMap((r) =>
      r.transfers
        .filter((x, i) => !(r.id === recordId && i === index) && !(requestId && x.batch && x.requestId === requestId))
        .flatMap(paidHashes)
    )
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
  !t.neverSent &&
  !t.foundOnChain

// The transfers handed out with the record's transfer at `index`: itself, or
// its whole batch in the order Disperse paid them, from `records`.
const batchIn = (records: DisbursementRecord[], record: DisbursementRecord, index: number): Member[] => {
  const t = record.transfers[index]
  if (!t.batch || !t.requestId) return [{ record, kind: record.kind, index, t }]
  const members: Member[] = []
  for (const r of records) {
    r.transfers.forEach((x, i) => {
      if (x.batch && x.requestId === t.requestId) members.push({ record: r, kind: r.kind, index: i, t: x })
    })
  }
  return members.sort((a, b) => Number(a.t.batchIndex) - Number(b.t.batchIndex))
}

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
  overview(): { chainId: number; token: string; payer: string | null; disperse: string; folders: PayoutFolder[] } {
    return {
      chainId: sendChainId(),
      token: sendTokenAddress(),
      payer: pinnedPayer(),
      disperse: DISPERSE_ADDRESS,
      folders: listPayoutFolders(this.root),
    }
  }

  // --- checking --------------------------------------------------------------

  async check(input: {
    folder: string
    kinds: string[]
    account: string
    unrelatedTxs?: string[]
    skipPaidOnChain?: boolean
    paidTxs?: string[]
    mode?: string
  }): Promise<CheckResult> {
    // A check starts over (the page reloaded, or another tab checks): what is
    // with the wallet stays in the ledger, settled below like the rest, and an
    // answer for it is still recorded when it comes (`issued`).
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
    const named = (values: string[] | undefined): string[] => {
      const out = (values || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      for (const value of out) {
        if (!NAMED.test(value)) throw new SendRefusedError(`"${value}" is not a transaction hash (0x and 64 hex digits), nor a hash and a recipient (0x…:0x…)`)
      }
      return out
    }
    const unrelatedTxs = named(input.unrelatedTxs)
    const paidTxs = named(input.paidTxs)
    const skipPaidOnChain = !!input.skipPaidOnChain
    const mode: PayMode = input.mode === "disperse" ? "disperse" : "transfers"

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
    // What was handed to a wallet before is settled first: until this
    // account's is, nothing else may be sent (it may hold its next nonce).
    // Another account's only stops its own payout (send refuses it).
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
          { file, filesDir: dir, dryRun: true, from: account, unrelatedTxs, skipPaidOnChain, paidTxs, walletFees: true },
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
        this.keepSettled(record, skipPaidOnChain || paidTxs.length > 0, notes)
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
    if (balance.lt(due)) problems.push(`${account} holds ${pnkExact(balance)}, less than the ${pnkExact(due)} to send`)
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

    // Disperse: the very contract this page knows, and what it is allowed.
    let disperse: CheckResult["disperse"] = null
    if (mode === "disperse") {
      const codeHash = await chain.codeHash(DISPERSE_ADDRESS)
      if (codeHash !== DISPERSE_CODE_HASH) {
        problems.push(
          `Disperse is not at ${DISPERSE_ADDRESS} on this chain as this page knows it (its code ${codeHash ? `hashes to ${codeHash}` : "is missing"}, ` +
            `not ${DISPERSE_CODE_HASH}): pay one transaction per transfer instead`
        )
      } else {
        if (count > MAX_BATCH) {
          problems.push(`${count} transfers are more than one Disperse transaction pays here (${MAX_BATCH}): untick a payout, or pay one transaction per transfer`)
        }
        const allowance = await chain.tokenAllowance(DISPERSE_ADDRESS)
        const confirmations = allowance.eq(due) ? 1 : 2
        disperse = { address: DISPERSE_ADDRESS, allowance: allowance.toString(), confirmations }
        if (count > 0) {
          notes.push(
            confirmations === 1
              ? `Disperse is already allowed exactly ${pnkExact(allowance)}: one confirmation pays all ${count} transfers`
              : `Two confirmations: approve Disperse (${DISPERSE_ADDRESS}) for exactly ${pnkExact(due)}` +
                  (allowance.gt(ZERO) ? ` (it is allowed ${pnkExact(allowance)} now)` : "") +
                  `, then pay all ${count} transfers in one transaction`
          )
        }
      }
    }

    this.plan =
      problems.length === 0 && count > 0
        ? { checkId: randomId(), account, mode, payouts: planned, expectedNonce: latest, touchedAt: Date.now() }
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
      mode,
      disperse,
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

  // --- sending ---------------------------------------------------------------

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

  // The ledger's record is still the one checked: nothing else wrote it.
  private assertUnchanged(record: DisbursementRecord): void {
    const disk = listDisbursements().find((r) => r.id === record.id)
    if (disk && JSON.stringify(disk.transfers) !== JSON.stringify(record.transfers)) {
      this.plan = null
      throw new SendRefusedError(`${displayPath(recordPath(record))} changed since the check: Check again`)
    }
  }

  // Nothing of this account's since the check, but this page's own
  // transactions: another one (another tab, another app, the CLI) could be a
  // payment the check did not see. Returns the account's next nonce.
  private async assertQuiet(chain: SendChain, plan: Plan): Promise<number> {
    // A nonce lower than the chain already showed is no transaction of the
    // account's: it is a node behind another.
    const [latest, pending] = await this.onceCaughtUp(
      () => Promise.all([chain.nonce("latest"), chain.nonce("pending")]),
      (nonces) => nonces[0] >= plan.expectedNonce
    )
    if (latest < plan.expectedNonce) {
      this.plan = null
      throw new SendRefusedError(
        `The RPC shows nonce ${latest} for ${plan.account}, behind the ${plan.expectedNonce} the chain showed a moment ago (a node ` +
          "lagging behind): Check again"
      )
    }
    if (latest !== plan.expectedNonce || pending !== latest) {
      this.plan = null
      throw new SendRefusedError(
        `${plan.account} has sent or is sending a transaction this page did not (nonce ${latest}, ${pending - latest} pending; ` +
          `expected ${plan.expectedNonce}, none pending): Check again`
      )
    }
    return latest
  }

  // What is read right after a transaction of the run was mined, when it is
  // not yet what that transaction leaves: read again for a moment. An RPC
  // served by several nodes may answer from one a block behind the one that
  // served the receipt, with what was there before.
  private async onceCaughtUp<T>(read: () => Promise<T>, caughtUp: (value: T) => boolean): Promise<T> {
    const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
    let value = await read()
    for (let tries = 0; tries < 3 && !caughtUp(value); tries++) {
      await sleep(pollMs)
      value = await read()
    }
    return value
  }

  private finish(plan: Plan): Step {
    for (const p of plan.payouts) {
      if (p.record.transfers.every((t) => t.status === "confirmed") && p.record.status !== "completed") {
        p.record.status = "completed"
        p.record.completedAt = new Date().toISOString()
        saveDisbursement(p.record)
      }
    }
    const done = plan.payouts.map((p) => ({ kind: p.kind, ledger: displayPath(recordPath(p.record)), status: p.record.status }))
    this.plan = null
    return { state: "done", payouts: done }
  }

  // Records transfers as handed to the wallet (`batch`: together, through
  // Disperse): saved before the wallet is asked, so that from here on the
  // ledger knows.
  private handOut(members: Member[], requestId: string, nonce: number, block: number, batch: boolean): void {
    const at = new Date().toISOString()
    members.forEach((m, i) => {
      clearTransaction(m.t)
      m.t.status = "requested"
      m.t.viaWallet = true
      m.t.requestedAt = at
      m.t.requestedNonce = nonce
      m.t.requestedBlock = block
      m.t.requestId = requestId
      if (batch) {
        m.t.batch = members.length
        m.t.batchIndex = i
      }
    })
    for (const record of Array.from(new Set(members.map((m) => m.record)))) {
      record.status = "in-progress"
      // A record holding browser-wallet transfers: code older than the
      // disburse page refuses it rather than signing a "requested" one anew.
      record.version = 2
      saveDisbursement(record)
    }
  }

  // One transfer at a time: the next one to hand to the wallet, recorded as
  // handed before the page gets it; or "done" once every chosen payout is paid.
  async next(input: { checkId: string }): Promise<Step> {
    const plan = this.livePlan(String(input.checkId))
    if (plan.mode !== "transfers") throw new SendRefusedError("This check pays through Disperse: Disburse asks for the batch")
    if (this.active) throw new SendRefusedError("A transfer is with the wallet already: wait until it is settled")
    const chain = this.chain(plan.account)
    for (const p of plan.payouts) {
      const index = p.record.transfers.findIndex((t) => t.status !== "confirmed")
      if (index < 0) continue
      this.assertUnchanged(p.record)
      const t = p.record.transfers[index]
      if (t.status !== "pending" && t.status !== "failed") {
        this.plan = null
        throw new SendRefusedError(`${t.recipient}'s transfer is ${t.status}, not ready to send: Check again`)
      }
      const latest = await this.assertQuiet(chain, plan)
      const amount = BigNumber.from(t.amount)
      try {
        await chain.simulateTransfer(t.recipient, amount)
      } catch (err) {
        this.plan = null
        throw new SendRefusedError(`Not sending ${pnk(amount)} to ${t.recipient}: ${errorMessage(err)}`)
      }
      const block = await chain.blockNumber()
      const requestId = randomId()
      const members: Member[] = [{ record: p.record, kind: p.kind, index, t }]
      this.handOut(members, requestId, latest, block, false)
      const expected = expectedFor(members)
      this.issued.set(requestId, { kind: "transfer", members: [{ recordId: p.record.id, index }] })
      this.active = { requestId, kind: "transfer", account: plan.account, members, expected, amount, nonce: latest, verified: false }
      return {
        state: "send",
        requestId,
        kind: p.kind,
        index,
        recipient: t.recipient,
        amount: t.amount,
        tx: { from: plan.account, to: expected.to, data: expected.data, value: "0x0", chainId: hexQuantity(p.record.chainId) },
      }
    }
    return this.finish(plan)
  }

  // Everything in one Disperse transaction: first, unless Disperse already
  // allows the total, the approval of exactly the total; then the batch,
  // recorded as handed before the page gets it; or "done".
  async nextBatch(input: { checkId: string }): Promise<Step> {
    const plan = this.livePlan(String(input.checkId))
    if (plan.mode !== "disperse") throw new SendRefusedError("This check pays one transaction per transfer: Disburse asks for each")
    if (this.active) throw new SendRefusedError("A transaction is with the wallet already: wait until it is settled")
    const chain = this.chain(plan.account)
    const members: Member[] = []
    for (const p of plan.payouts) {
      this.assertUnchanged(p.record)
      p.record.transfers.forEach((t, index) => {
        if (t.status !== "confirmed") members.push({ record: p.record, kind: p.kind, index, t })
      })
    }
    if (members.length === 0) return this.finish(plan)
    const busy = members.find((m) => m.t.status !== "pending" && m.t.status !== "failed")
    if (busy) {
      this.plan = null
      throw new SendRefusedError(`${busy.t.recipient}'s transfer is ${busy.t.status}, not ready to send: Check again`)
    }
    if (members.length > MAX_BATCH) {
      this.plan = null
      throw new SendRefusedError(`${members.length} transfers are more than one Disperse transaction pays here (${MAX_BATCH}): Check again`)
    }
    const latest = await this.assertQuiet(chain, plan)
    const token = members[0].record.token
    const chainId = members[0].record.chainId
    const total = sumOf(members)
    // Right after this run's approval, the total is what Disperse is allowed.
    const approved = plan.approved === total.toString()
    const [codeHash, balance, allowance] = await Promise.all([
      chain.codeHash(DISPERSE_ADDRESS),
      chain.tokenBalance(),
      this.onceCaughtUp(
        () => chain.tokenAllowance(DISPERSE_ADDRESS),
        (value) => !approved || value.eq(total)
      ),
    ])
    if (codeHash !== DISPERSE_CODE_HASH) {
      this.plan = null
      throw new SendRefusedError(`Disperse is not at ${DISPERSE_ADDRESS} on this chain as this page knows it: Check again`)
    }
    if (balance.lt(total)) {
      this.plan = null
      throw new SendRefusedError(`${plan.account} holds ${pnkExact(balance)}, less than the ${pnkExact(total)} to send: Check again`)
    }
    const requestId = randomId()
    if (!allowance.eq(total) && approved) {
      // Approved a moment ago, and not allowed that now: never a second
      // approval in one run, which the page would refuse.
      this.plan = null
      throw new SendRefusedError(
        `Disperse is allowed ${pnkExact(allowance)}, not the ${pnkExact(total)} this run's approval allowed it a moment ago: Check again`
      )
    }
    if (!allowance.eq(total)) {
      // Exactly the total, whatever Disperse was allowed before: what this
      // batch spends, nothing left allowed once it is paid, so that no other
      // batch (a request still open in the wallet) can spend anything after
      // it. An approval pays no one, so the ledger does not record it: the
      // next check reads what Disperse is allowed.
      const data = approveCalldata(DISPERSE_ADDRESS, total)
      try {
        await chain.simulateCall(token, data, `approve(Disperse, ${total.toString()})`)
      } catch (err) {
        this.plan = null
        throw new SendRefusedError(`Not approving Disperse: ${errorMessage(err)}`)
      }
      const expected: Expected = { to: token, toName: "PNK", data, what: "approve(Disperse, total)" }
      this.issued.set(requestId, { kind: "approve", members: [] })
      this.active = { requestId, kind: "approve", account: plan.account, members: [], expected, amount: total, nonce: latest, verified: false }
      return {
        state: "approve",
        requestId,
        spender: DISPERSE_ADDRESS,
        amount: total.toString(),
        tx: { from: plan.account, to: token, data, value: "0x0", chainId: hexQuantity(chainId) },
      }
    }
    const data = disperseCalldata(token, members.map((m) => m.t))
    // (a node still behind this run's approval would have the batch revert)
    const refusal = await this.onceCaughtUp(
      () =>
        chain.simulateCall(DISPERSE_ADDRESS, data, `Disperse of ${members.length} transfers (${pnk(total)})`).then(
          () => "",
          (err) => errorMessage(err) || "it would revert"
        ),
      (why) => !approved || why === ""
    )
    if (refusal) {
      this.plan = null
      throw new SendRefusedError(`Not sending the batch: ${refusal}`)
    }
    const block = await chain.blockNumber()
    this.handOut(members, requestId, latest, block, true) // a batch even of one: its calldata is Disperse's
    const expected = expectedFor(members)
    this.issued.set(requestId, { kind: "disperse", members: members.map((m) => ({ recordId: m.record.id, index: m.index })) })
    this.active = { requestId, kind: "disperse", account: plan.account, members, expected, amount: total, nonce: latest, verified: false }
    return {
      state: "disperse",
      requestId,
      transfers: members.map((m) => ({ kind: m.kind, index: m.index, recipient: m.t.recipient, amount: m.t.amount })),
      total: total.toString(),
      tx: { from: plan.account, to: DISPERSE_ADDRESS, data: expected.data, value: "0x0", chainId: hexQuantity(chainId) },
    }
  }

  // The ledger's record by id: the very copy a run holds when it uses that
  // record (saving a fresh read would be undone by the run's next save).
  private ledgerRecord(recordId: string): DisbursementRecord | undefined {
    return this.heldRecords().find((r) => r.id === recordId) || listDisbursements().find((r) => r.id === recordId)
  }

  // The records a run holds: the wallet's transaction's, and the plan's.
  private heldRecords(): DisbursementRecord[] {
    return (this.active ? this.active.members.map((m) => m.record) : []).concat(this.plan ? this.plan.payouts.map((p) => p.record) : [])
  }

  // Every record of the ledger, read once, each as the one copy this call
  // works on.
  private ledgerRecords(): DisbursementRecord[] {
    const held = this.heldRecords()
    return listDisbursements().map((r) => held.find((h) => h.id === r.id) || r)
  }

  private current(requestId: string): Active {
    const a = this.active
    if (!a || a.requestId !== String(requestId)) throw new SendRefusedError("No such transfer is with the wallet: Check again")
    return a
  }

  private what(a: Active): string {
    if (a.kind === "approve") return `the approval of ${pnk(a.amount)} for Disperse`
    return a.members.length > 1 || a.kind === "disperse" ? `the batch of ${a.members.length} transfers (${pnk(a.amount)})` : "the transfer"
  }

  // The wallet answered a hash: kept at once, and the transaction of what it
  // pays once the chain shows it is exactly what was asked. An answer for
  // something handed out before the page reloaded (or by another tab) is kept
  // too.
  async sent(input: { requestId: string; hash: string }): Promise<{ state: "sent" | "unverified"; hash: string; url: string | null }> {
    const hash = String(input.hash || "").toLowerCase()
    if (!HASH.test(hash)) throw new SendRefusedError(`"${input.hash}" is not a transaction hash`)
    const a = this.active && this.active.requestId === String(input.requestId) ? this.active : null
    if (!a) return this.lateAnswer(String(input.requestId), hash)
    if (a.hash && a.hash !== hash) {
      // kept all the same: every hash a wallet gives is evidence
      const fresh = a.members.filter((m) => !(m.t.strayTxs || []).includes(hash))
      for (const m of fresh) m.t.strayTxs = union(m.t.strayTxs, [hash])
      if (fresh.length > 0) saveAll(fresh)
      throw new SendRefusedError(`The wallet answered ${a.hash} for this already, and now ${hash}: both are recorded. Check again.`)
    }
    const chainId = sendChainId()
    const url = explorerTxUrl(chainId, hash)
    if (!a.hash) {
      a.hash = hash
      for (const m of a.members) m.t.reportedTxHash = hash
      saveAll(a.members)
    }
    if (a.verified) return { state: "sent", hash, url }
    const chain = this.chain(a.account)
    const tx = await chain.transactionDetails(hash)
    if (!tx) return { state: "unverified", hash, url } // the RPC has not seen it yet
    const wrong =
      a.kind === "approve"
        ? approvalMismatch(tx, a.account, a.expected.to, chainId, a.nonce)
        : transferMismatch(tx, { ...a.expected, from: a.account, chainId, minNonce: a.nonce })
    if (wrong) {
      // Never recorded as their transaction; the transfers stay "requested",
      // for the next check to settle from the chain.
      this.active = null
      this.plan = null
      throw new SendRefusedError(
        a.kind === "approve"
          ? `The wallet's transaction ${hash} is not the approval it was asked for: ${wrong}. Look at it on the explorer, then Check again.`
          : `The wallet's transaction ${hash} is not ${this.what(a)} it was asked for: ${wrong}. It is not recorded as ` +
              `${a.members.length > 1 ? "their" : "its"} payment. Look at it on the explorer, then Check again: the check ` +
              "settles it from the chain."
      )
    }
    a.verified = true
    a.txNonce = tx.nonce
    for (const m of a.members) {
      m.t.status = "sent"
      m.t.txHash = hash
      m.t.nonce = tx.nonce
      m.t.attempts = [hash]
      delete m.t.reportedTxHash
    }
    saveAll(a.members)
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
            ? `${a.account} sent ${Math.min(latest, tx.nonce) - a.nonce} other transaction(s) since it was handed to the wallet (a request approved late?)`
            : `the wallet holds ${tx.nonce - a.nonce} earlier transaction(s) of ${a.account} that this node does not know (one marked as never sent, sent after all?)`) +
          `, mined before it. It is recorded as ${a.kind === "approve" ? "the approval" : `${this.what(a)}'s transaction`}. ` +
          "Look at the wallet's activity before anything else, then Check again."
      )
    }
    return { state: "sent", hash, url }
  }

  // An answer for what is no longer with the wallet (the page reloaded,
  // another tab checked): recorded on its transfers all the same, so that no
  // hash the wallet gave is ever lost.
  private async lateAnswer(requestId: string, hash: string): Promise<never> {
    const issued = this.issued.get(requestId)
    if (!issued) throw new SendRefusedError("No such transfer was handed to the wallet: Check again")
    if (issued.kind === "approve") {
      throw new SendRefusedError(
        `The wallet answered ${hash} for an approval of Disperse, after this page moved on: Check again (the check reads what ` +
          "Disperse is allowed)"
      )
    }
    const records = new Map<string, DisbursementRecord | undefined>()
    const recordOf = (id: string) => {
      if (!records.has(id)) records.set(id, this.ledgerRecord(id))
      return records.get(id)
    }
    const members: Member[] = []
    for (const { recordId, index } of issued.members) {
      const record = recordOf(recordId)
      const t = record ? record.transfers[index] : undefined
      if (!record || !t) throw new SendRefusedError("The transfer this answer is for is no longer in the ledger: look at it on the explorer")
      members.push({ record, kind: record.kind, index, t })
    }
    const first = members[0].t
    const label = members.length > 1 || issued.kind === "disperse" ? `the batch of ${members.length} transfers (${pnk(sumOf(members))})` : `${pnk(first.amount)} to ${first.recipient}`
    const one = members.length > 1 || issued.kind === "disperse" ? "the batch" : "the transfer"
    if (members.every((m) => isRequested(m.t) && m.t.requestId === requestId && m.t.reportedTxHash === hash)) {
      throw new SendRefusedError(`The wallet's answer ${hash} for ${label} is recorded already. Check again: the check settles it from the chain.`)
    }
    if (members.every((m) => isRequested(m.t) && m.t.requestId === requestId && !m.t.reportedTxHash)) {
      for (const m of members) m.t.reportedTxHash = hash
      saveAll(members)
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${label}, after this page checked again: it is recorded. Check again: the check ` +
          "settles it from the chain."
      )
    }
    if (members.every((m) => paidHashes(m.t).includes(hash))) {
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${label} after this page checked again, which already settled ${one} from the ` +
          `chain (${first.status}, by this very transaction). Check again.`
      )
    }
    const fresh = members.filter((m) => !(m.t.strayTxs || []).includes(hash) && !paidHashes(m.t).includes(hash))
    for (const m of fresh) m.t.strayTxs = union(m.t.strayTxs, [hash])
    if (fresh.length > 0) saveAll(fresh)
    // The run stops: the next check settles the transfers from the chain, and
    // says whether they were paid twice.
    this.plan = null
    if (first.status !== "confirmed") {
      throw new SendRefusedError(
        `The wallet answered ${hash} for ${label} for an earlier hand-out of it (the transfer is now ${first.status}): it ` +
          "is recorded on it. If both are sent, the recipient is paid twice: reject any request for it still open in the " +
          "wallet, then Check again, which settles it from the chain."
      )
    }
    throw new SendRefusedError(
      `The wallet answered ${hash} for ${label} late, after that transfer was settled (${first.status})` +
        `${first.requestId === requestId ? "" : ", for an earlier hand-out of it"}. It is recorded on it. Look it up on the ` +
        "explorer: if it is mined as well as the transfer's own payment, the recipient was paid twice (the next Check says " +
        "so), and the excess is to be recovered by hand."
    )
  }

  // Waits a little for the transaction to be mined.
  async receipt(input: { requestId: string }): Promise<Receipt> {
    const a = this.current(input.requestId)
    if (!a.verified || !a.hash) throw new SendRefusedError("The wallet's transaction is not known yet")
    const chain = this.chain(a.account)
    const deadline = Date.now() + this.waitMs
    const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
    for (;;) {
      const outcome = a.kind === "approve" ? await this.settleApproval(chain, a) : await this.settleMembers(chain, a.members)
      if (outcome.state === "confirmed") {
        this.active = null
        for (const record of Array.from(new Set(a.members.map((m) => m.record)))) {
          if (record.status !== "completed" && record.transfers.every((t) => t.status === "confirmed")) {
            record.status = "completed"
            record.completedAt = new Date().toISOString()
            saveDisbursement(record)
          }
        }
        if (this.plan) {
          // the wallet used the nonce it was expected to: what follows may follow
          const used = a.kind === "approve" ? a.txNonce : a.members[0].t.nonce
          if (used === a.nonce) this.plan.expectedNonce = a.nonce + 1
          else this.plan = null
          if (this.plan && a.kind === "approve") this.plan.approved = a.amount.toString()
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
    if (a.hash) {
      this.plan = null
      return { state: "unsettled", message: "The wallet answered a hash for it before: Check again to settle it" }
    }
    const chain = this.chain(a.account)
    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (latest === a.nonce && pending === latest) {
      for (const m of a.members) {
        clearTransaction(m.t)
        m.t.status = "pending"
      }
      saveAll(a.members)
      return { state: "cleared", message: "Rejected in the wallet: nothing was sent" }
    }
    this.plan = null
    return {
      state: "unsettled",
      message: "The account's nonce moved since it was handed to the wallet: Check again, which settles it from the chain",
    }
  }

  // The wallet failed without saying whether it sent it: left for the next
  // check to settle from the chain.
  async failed(input: { requestId: string; message?: string }): Promise<{ state: "unsettled"; message: string }> {
    const a = this.current(input.requestId)
    this.active = null
    this.plan = null
    const what =
      a.kind === "transfer" ? `${pnk(a.members[0].t.amount)} to ${a.members[0].t.recipient}` : this.what(a)
    return {
      state: "unsettled",
      message:
        `The wallet answered "${String(input.message || "an error")}", which does not say whether it sent ${what}. ` +
        "Look at the wallet's activity, then Check again: the check settles it from the chain.",
    }
  }

  // --- settling what the chain does not settle on its own -----------------

  // The transfer at `index` and those handed out with it (its batch), each
  // handed to a wallet and waiting to be settled. Only part of a batch when
  // the page stopped while recording it: then it never reached the wallet.
  private walletMembers(recordId: string, index: number): Member[] {
    const record = this.ledgerRecord(String(recordId))
    if (!record) throw new SendRefusedError("No such payout in the ledger")
    const t = record.transfers[Number(index)]
    if (!t) throw new SendRefusedError("That transfer is not one handed to a wallet and waiting to be settled")
    const records = this.ledgerRecords()
    const members = batchIn(records, records.find((r) => r.id === record.id) as DisbursementRecord, Number(index))
    for (const m of members) {
      if (!(isRequested(m.t) || (m.t.viaWallet && m.t.status === "sent"))) {
        throw new SendRefusedError("That transfer is not one handed to a wallet and waiting to be settled")
      }
      if (this.active && this.active.members.some((x) => x.record.id === m.record.id && x.index === m.index)) {
        throw new SendRefusedError("That transfer is with the wallet right now: answer it there first")
      }
    }
    if (t.batch && members.length !== t.batch && members.some((m) => answered(m.t))) {
      throw new SendRefusedError(
        `Only ${members.length} of the batch's ${t.batch} transfers are in the ledger as handed to the wallet: restore ` +
          "disbursements/ from git"
      )
    }
    return members
  }

  // The operator gives the hash the wallet's activity shows for a transfer,
  // or for its batch.
  async recordHash(input: { recordId: string; index: number; hash: string }): Promise<{ state: string; message: string }> {
    const members = this.walletMembers(input.recordId, input.index)
    const first = members[0]
    const one = first.t.batch ? "batch" : "transfer"
    const hash = String(input.hash || "").toLowerCase()
    if (!HASH.test(hash)) throw new SendRefusedError(`"${input.hash}" is not a transaction hash`)
    const chain = this.chain(first.record.from)
    const tx = await chain.transactionDetails(hash)
    if (!tx) throw new SendRefusedError(`The RPC does not know ${hash}: check the hash, or wait until the transaction spreads`)
    const expected = expectedFor(members)
    const wrong = transferMismatch(tx, { ...expected, from: first.record.from, chainId: first.record.chainId, minNonce: first.t.requestedNonce })
    if (wrong) throw new SendRefusedError(`${hash} is not this ${one}: ${wrong}`)
    if (ledgerHashesBut(first.record.id, first.index, first.t.requestId).has(hash)) {
      throw new SendRefusedError(`${hash} already pays another transfer of the ledger`)
    }
    // What the wallet answered for it, if another hash: taken over only once
    // the chain shows it cannot pay unseen.
    let stray: string | null = null
    const reported = first.t.reportedTxHash ? first.t.reportedTxHash.toLowerCase() : null
    if (reported && reported !== hash) {
      const answeredTx = await chain.transactionDetails(reported)
      const answeredWrong = answeredTx
        ? transferMismatch(answeredTx, { ...expected, from: first.record.from, chainId: first.record.chainId, minNonce: first.t.requestedNonce })
        : ""
      if (answeredTx && !answeredWrong) throw new SendRefusedError(`The wallet answered ${reported} for it, which is this ${one}: Check again, which settles it`)
      if (answeredTx && answeredTx.blockNumber === null) {
        throw new SendRefusedError(`The wallet answered ${reported} for it, which is not mined yet: wait until it is, then decide`)
      }
      if (!answeredTx && tx.blockNumber === null) {
        throw new SendRefusedError(
          `The wallet answered ${reported} for it, which the RPC does not know: ${hash} is taken for it once mined (wait for it), ` +
            "when no other transaction of the account can still use its nonce"
        )
      }
      stray = reported
    }
    // A transfer paid by another transaction since it was handed out: the
    // check records that one. (A batch's own transaction is taken all the
    // same: a payment of one of its transfers by another one is then a second
    // payment, which the check reports.)
    if (!first.t.batch) {
      const payment = await this.paymentSince(chain, first.record, first.t, hash)
      if (payment) {
        throw new SendRefusedError(
          `${payment.txHash} (block ${payment.blockNumber}) already pays it: Check again, which records it.` +
            (tx.blockNumber !== null ? ` ${hash} is mined too: the recipient was paid twice.` : "")
        )
      }
    }
    if (first.t.status === "sent" && first.t.nonce !== undefined && tx.nonce !== first.t.nonce) {
      // Another nonce than its transaction's: only once that one can no
      // longer be mined (its nonce taken), or both could pay.
      if ((await chain.nonce("latest")) <= first.t.nonce) {
        throw new SendRefusedError(
          `${hash} has nonce ${tx.nonce}, and the ${one}'s transaction ${first.t.txHash} (nonce ${first.t.nonce}) may still be ` +
            "mined: wait for it, or cancel it in the wallet, then give the hash again"
        )
      }
      for (const m of members) {
        m.t.forgottenTxs = union(m.t.forgottenTxs, paidHashes(m.t))
        m.t.attempts = []
      }
    }
    for (const m of members) {
      m.t.status = "sent"
      m.t.viaWallet = true
      m.t.txHash = hash
      m.t.nonce = tx.nonce
      m.t.attempts = union(m.t.attempts, [hash])
      if (stray) m.t.strayTxs = union(m.t.strayTxs, [stray])
      delete m.t.reportedTxHash
    }
    saveAll(members)
    const outcome = await this.settleMembers(chain, members)
    this.plan = null
    return {
      state: outcome.state,
      message: `Recorded ${hash} as the ${one === "batch" ? `batch's ${members.length} transfers'` : "transfer's"} transaction (${outcome.state}). Check again.`,
    }
  }

  // The operator says the wallet never sent it (a transfer, or its batch), or
  // that its transaction is gone. Taken only when the chain cannot contradict
  // it: nothing of the account's pending, no payment of it since it was handed
  // out (for a batch: the batch itself never mined), its own transaction (if
  // any) past mining (its nonce used by another), and a hash the wallet
  // answered for it either mined as another transaction, or unknown to the
  // node with the account's nonce moved on. A batch's transfers paid by other
  // transactions of the account since (a request approved late) are recorded
  // as paid by those; only the rest is marked never sent.
  async forget(input: { recordId: string; index: number }): Promise<{ state: "cleared"; message: string }> {
    const members = this.walletMembers(input.recordId, input.index)
    const first = members[0]
    const batch = !!first.t.batch
    const from = first.record.from
    const chain = this.chain(from)
    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (pending > latest) throw new SendRefusedError(`${from} has a transaction pending: wait until it is mined, then decide`)
    // The wallet answered a hash for it: only once the chain shows that hash
    // is not it, or it never arrived and the nonce moved on.
    let stray: string | null = null
    if (first.t.reportedTxHash) {
      const reported = first.t.reportedTxHash
      const tx = await chain.transactionDetails(reported)
      const wrong = tx
        ? transferMismatch(tx, { ...expectedFor(members), from, chainId: first.record.chainId, minNonce: first.t.requestedNonce })
        : ""
      if (tx && !wrong) throw new SendRefusedError(`The wallet answered ${reported} for it, which is this ${batch ? "batch" : "transfer"}: Check again, which settles it`)
      if (tx && tx.blockNumber === null) {
        throw new SendRefusedError(`The wallet answered ${reported} for it, which is not mined yet: wait until it is, then decide`)
      }
      if (!tx && latest <= Number(first.t.requestedNonce)) {
        throw new SendRefusedError(
          `The wallet answered ${reported} for it, which the RPC does not know, and the account has sent nothing since: it may ` +
            "still be sent. If the wallet shows it pending, speed it up or cancel it there, then Check."
        )
      }
      if (tx) stray = reported // mined, and another transaction than this
    }
    let paidElsewhere: { member: Member; txHash: string; blockNumber: number }[] = []
    if (batch) {
      const found = await this.batchPayment(chain, members)
      if (found.batchTx) {
        throw new SendRefusedError(
          `Not forgetting it: ${found.batchTx.txHash} (block ${found.batchTx.blockNumber}) is the batch itself, mined. Check again: ` +
            "the check records it."
        )
      }
      paidElsewhere = found.others
    } else {
      const payment = await this.paymentSince(chain, first.record, first.t)
      if (payment) {
        throw new SendRefusedError(
          `Not forgetting it: ${payment.txHash} (block ${payment.blockNumber}) pays ${first.t.recipient} exactly this amount since the ` +
            "transfer was handed to the wallet. Check again: the check records it."
        )
      }
    }
    if (first.t.status === "sent" && first.t.nonce !== undefined && latest <= first.t.nonce) {
      // Signed and broadcast, its nonce still free: a node or the wallet may
      // still send it, however long it has been gone from this one.
      throw new SendRefusedError(
        `Its transaction ${first.t.txHash} (nonce ${first.t.nonce}) is not mined, and nonce ${first.t.nonce} is still free: a node, ` +
          `or the wallet, may still send it. Use that nonce first: cancel it in the wallet, or send any transaction from ${from} ` +
          `with nonce ${first.t.nonce} (a 0-value one to itself). Then Check again: once the chain shows nothing pays it, it can ` +
          "be marked as never sent."
      )
    }
    for (const m of members) {
      const other = paidElsewhere.find((o) => o.member === m)
      if (other) {
        // paid by another transaction of the account: recorded as such, out of the batch
        this.recordPayment(m.record, m.t, { txHash: other.txHash, blockNumber: other.blockNumber, nonce: null })
        delete m.t.batch
        delete m.t.batchIndex
        continue
      }
      const own = paidHashes(m.t).concat(m.t.reportedTxHash && !stray ? [m.t.reportedTxHash.toLowerCase()] : [])
      if (own.length > 0) m.t.forgottenTxs = union(m.t.forgottenTxs, own)
      if (stray) m.t.strayTxs = union(m.t.strayTxs, [stray])
      clearTransaction(m.t)
      m.t.status = "pending"
      // handed to a wallet once: its record is never moved to another account
      m.t.neverSent = (m.t.neverSent || 0) + 1
    }
    saveAll(members)
    this.plan = null
    const rest = members.length - paidElsewhere.length
    return {
      state: "cleared",
      message: !batch
        ? `${first.t.recipient}'s transfer is marked as never sent: Check again to send it`
        : `The batch's ${rest} transfer(s) are marked as never sent: Check again to send them` +
          (paidElsewhere.length > 0
            ? `. ${paidElsewhere.length} of its transfers were paid by other transactions of the account since it was handed ` +
              `out (${paidElsewhere.map((o) => `${pnk(o.member.t.amount)} to ${o.member.t.recipient}: ${o.txHash}`).join("; ")}): ` +
              "recorded as paid by them."
            : ""),
    }
  }

  // A payment of the transfer from the payout's account, mined since the
  // transfer was handed to the wallet: one of its own transactions (found in
  // the Transfer logs, the receipt lagging or gone), or one the ledger does
  // not know with a nonce from the one it was handed out with (the wallet's
  // replacement, or a request approved late). `except`: a hash not to count.
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
    const others = ledgerHashesBut(record.id, record.transfers.indexOf(t), t.requestId)
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
        return { state: "reverted", hash, message: `${hash} reverted: nothing was paid by it. Check again to send anew.` }
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

  // Transfers sent in one transaction (one, or a batch), settled together.
  private async settleMembers(chain: SendChain, members: Member[]): Promise<Receipt> {
    if (!members[0].t.batch) return this.settleSent(chain, members[0].record, members[0].t)
    const outcome = await this.settleBatch(chain, members)
    if (outcome.state === "open") {
      return outcome.wait ? { state: "pending", hash: String(outcome.hash || members[0].t.txHash || "") } : { state: "stopped", message: outcome.message }
    }
    return outcome
  }

  // A Disperse batch, settled from the chain as one: by its own transaction,
  // its receipt or its Transfer logs, or by the wallet's replacement of it
  // (from the account, to Disperse, with exactly its calldata, a nonce from
  // the hand-out's on). Never transfer by transfer by other transactions:
  // those pay what they name, not the batch, and are left to the operator.
  private async settleBatch(chain: SendChain, members: Member[]): Promise<BatchOutcome> {
    const first = members[0]
    const from = first.record.from
    const chainId = first.record.chainId
    const expected = expectedFor(members)
    const isBatch = (tx: TransactionDetails | null): tx is TransactionDetails =>
      !!tx && !transferMismatch(tx, { ...expected, from, chainId, minNonce: first.t.requestedNonce })
    const confirmAll = (payment: { txHash: string; blockNumber: number; nonce: number | null }, found: boolean, note?: string): BatchOutcome => {
      for (const m of members) this.recordPayment(m.record, m.t, payment)
      return {
        state: "confirmed",
        hash: payment.txHash,
        block: payment.blockNumber,
        url: explorerTxUrl(chainId, payment.txHash),
        found,
        ...(note ? { note } : {}),
      }
    }
    const elsewhere = (others: { member: Member; txHash: string; blockNumber: number }[]): string =>
      others.length === 0
        ? ""
        : ` Meanwhile ${others.map((o) => `${o.txHash} (block ${o.blockNumber}) paid ${pnk(o.member.t.amount)} to ${o.member.t.recipient}`).join("; ")}, ` +
          "by transactions that are not the batch (a request approved late?): marking the batch as never sent records those " +
          "as paid by them, and sends only the rest anew."
    // The wallet's answer, once the chain shows it is the batch.
    if (isRequested(first.t) && first.t.reportedTxHash) {
      const tx = await chain.transactionDetails(first.t.reportedTxHash)
      if (isBatch(tx)) this.markSent(members, String(first.t.reportedTxHash), tx.nonce)
    }
    if (first.t.status === "sent") {
      const hash = String(first.t.txHash)
      // One transaction for all of them, so one receipt, read once: it settles
      // every transfer or none. (Read per transfer, a receipt that a node
      // serves a moment later than another would settle only some of them.)
      // The transaction is the wallet's, or another the operator gave for it
      // with the same nonce (sped up): each was shown to be the batch, and
      // only one of them can be mined.
      const candidates = Array.from(new Set((first.t.attempts || []).concat(hash).map((h) => h.toLowerCase())))
      const byReceipt = async (): Promise<BatchOutcome | null> => {
        for (const h of candidates) {
          const receipt = await chain.receipt(h)
          if (!receipt) continue
          if (receipt.status !== 1) {
            for (const m of members) {
              if (m.t.status === "confirmed") continue // paid is paid: never one to send again
              m.t.revertedTxs = union(m.t.revertedTxs, [h])
              clearTransaction(m.t)
              m.t.status = "failed"
            }
            saveAll(members)
            return { state: "reverted", hash: h, message: `${h} reverted: nothing was paid by it. Check again to send the batch anew.` }
          }
          return confirmAll({ txHash: h, blockNumber: receipt.blockNumber, nonce: first.t.nonce === undefined ? null : first.t.nonce }, false)
        }
        return null
      }
      const settled = await byReceipt()
      if (settled) return settled
      const latest = await chain.nonce("latest")
      if (first.t.nonce === undefined || latest <= first.t.nonce) {
        const known = await chain.transactionDetails(hash)
        return known
          ? { state: "open", wait: true, hash, message: `its transaction ${hash} is not mined yet: wait for it (or speed it up in the wallet), then Check again`, actions: [] }
          : {
              state: "open",
              wait: true,
              hash,
              message:
                `its transaction ${hash} is not mined, and the RPC no longer knows it (dropped?), but its nonce ${first.t.nonce} is ` +
                "free, so it may still be sent. If the wallet shows another transaction for it (sped up), give that one's hash. " +
                `Otherwise cancel it in the wallet, or send any transaction from ${from} with nonce ${first.t.nonce} (a 0-value one ` +
                "to itself), then Check again: it can then be marked as never sent.",
              actions: ["hash"],
            }
      }
      // Its nonce is used: by it, its receipt not served yet, or by a replacement.
      const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
      for (let tries = 0; tries < 3; tries++) {
        await sleep(pollMs)
        const again = await byReceipt()
        if (again) return again
      }
      const found = await this.batchPayment(chain, members)
      if (found.batchTx) {
        return confirmAll(found.batchTx, false, found.batchTx.own ? undefined : `paid by ${found.batchTx.txHash}, the wallet's replacement of ${hash} (sped up)`)
      }
      return {
        state: "open",
        wait: false,
        message:
          `${hash} can no longer be mined: its nonce went to another transaction, and the batch is not paid by any other ` +
          `(cancelled in the wallet?).${elsewhere(found.others)} Once you confirm in the wallet it was never sent, mark it as never sent.`,
        actions: ["hash", "forget"],
      }
    }
    // "requested": the wallet's answer lost, or not (yet) shown to be the batch
    const [latest, pending] = await Promise.all([chain.nonce("latest"), chain.nonce("pending")])
    if (pending > latest) {
      return { state: "open", wait: true, message: `${from} has a transaction pending, maybe this one: wait until it is mined, then Check again`, actions: [] }
    }
    const reported = first.t.reportedTxHash
    const found = latest > Number(first.t.requestedNonce) || reported ? await this.batchPayment(chain, members) : { batchTx: null, others: [] }
    if (found.batchTx) return confirmAll(found.batchTx, true)
    const others = elsewhere(found.others)
    if (reported) {
      const tx = await chain.transactionDetails(reported)
      if (tx && tx.blockNumber === null) {
        return { state: "open", wait: true, message: `the wallet answered ${reported} for it, which is not it and is not mined yet: wait until it is, then Check again`, actions: [] }
      }
      if (tx) {
        return {
          state: "open",
          wait: false,
          message:
            `the wallet answered ${reported} for it, mined in block ${tx.blockNumber}, which is not this batch ` +
            `(${transferMismatch(tx, { ...expected, from, chainId, minNonce: first.t.requestedNonce })}), and nothing else is the batch.${others} ` +
            "If the wallet's activity shows another hash for it, give that one; otherwise mark it as never sent.",
          actions: ["hash", "forget"],
        }
      }
      if (latest <= Number(first.t.requestedNonce)) {
        return {
          state: "open",
          wait: false,
          message:
            `the wallet answered ${reported} for it, which the RPC does not know. If the wallet shows it pending, speed it up or ` +
            "cancel it there, then Check again. If the wallet's activity shows another hash for it, give that one. If it shows " +
            `nothing, use nonce ${first.t.requestedNonce}: send any transaction from ${from} (a 0-value one to itself); then it ` +
            "can be marked as never sent.",
          actions: ["hash"],
        }
      }
      return {
        state: "open",
        wait: false,
        message:
          `the wallet answered ${reported} for it, which the RPC does not know, and the account has sent ` +
          `${latest - Number(first.t.requestedNonce)} transaction(s) since, none of which is the batch.${others} If the wallet's ` +
          "activity shows another hash for it, give that one; if it shows none, mark it as never sent.",
        actions: ["hash", "forget"],
      }
    }
    return {
      state: "open",
      wait: false,
      message:
        latest === Number(first.t.requestedNonce)
          ? `handed to the wallet on ${String(first.t.requestedAt).slice(0, 19)}Z, and the account has sent nothing since. If the ` +
            "wallet still shows that request, reject it there; then mark it as never sent."
          : `handed to the wallet on ${String(first.t.requestedAt).slice(0, 19)}Z with nonce ${first.t.requestedNonce}; the account ` +
            `has sent ${latest - Number(first.t.requestedNonce)} transaction(s) since, none of which is the batch.${others} Look at ` +
            "the wallet's activity: give its hash if it was sent, or mark it as never sent.",
      actions: ["hash", "forget"],
    }
  }

  // What paid a batch's transfers since it was handed out, from the account's
  // Transfer logs: the batch itself (its own transaction, or one with exactly
  // its calldata: the wallet's replacement), or else, transfer by transfer,
  // other transactions (each Transfer log paying one transfer at most).
  private async batchPayment(
    chain: SendChain,
    members: Member[]
  ): Promise<{
    batchTx: { txHash: string; blockNumber: number; nonce: number | null; own: boolean } | null
    others: { member: Member; txHash: string; blockNumber: number }[]
  }> {
    const first = members[0]
    const fromBlock = first.t.requestedBlock !== undefined ? first.t.requestedBlock : first.record.startBlock
    const blockTime = fromBlock !== undefined ? await chain.blockTimestamp(fromBlock) : null
    const sinceUnix = blockTime !== null ? blockTime : Math.floor(Date.parse(String(first.t.requestedAt || first.record.createdAt)) / 1000) - 86400
    const own = new Set(members.flatMap((m) => Array.from(ownHashes(m.t))))
    const ledger = ledgerHashesBut(first.record.id, first.index, first.t.requestId)
    const logs = (await chain.outgoingTransfers(sinceUnix)).filter((f) => fromBlock === undefined || f.blockNumber >= fromBlock)
    const pays = (f: { to: string; amount: string }, m: Member) => f.to.toLowerCase() === m.t.recipient.toLowerCase() && f.amount === m.t.amount
    const expected = expectedFor(members)
    const hashes = Array.from(new Set(logs.filter((f) => members.some((m) => pays(f, m))).map((f) => f.txHash.toLowerCase())))
    for (const hash of hashes) {
      if (ledger.has(hash) && !own.has(hash)) continue
      const tx = await chain.transactionDetails(hash)
      if (tx && !transferMismatch(tx, { ...expected, from: first.record.from, chainId: first.record.chainId, minNonce: first.t.requestedNonce })) {
        const log = logs.find((f) => f.txHash.toLowerCase() === hash) as { blockNumber: number }
        return { batchTx: { txHash: hash, blockNumber: log.blockNumber, nonce: tx.nonce, own: own.has(hash) }, others: [] }
      }
    }
    const pool = logs.filter((f) => !ledger.has(f.txHash.toLowerCase()) && !own.has(f.txHash.toLowerCase()) && (fromBlock === undefined || f.blockNumber > fromBlock))
    const others: { member: Member; txHash: string; blockNumber: number }[] = []
    for (const m of members) {
      const i = pool.findIndex((f) => pays(f, m))
      if (i >= 0) {
        const f = pool.splice(i, 1)[0]
        others.push({ member: m, txHash: f.txHash.toLowerCase(), blockNumber: f.blockNumber })
      }
    }
    return { batchTx: null, others }
  }

  // The wallet's answer, shown by the chain to be the batch: its transaction.
  private markSent(members: Member[], hash: string, nonce: number): void {
    for (const m of members) {
      m.t.status = "sent"
      m.t.txHash = hash.toLowerCase()
      m.t.nonce = nonce
      m.t.attempts = [hash.toLowerCase()]
      delete m.t.reportedTxHash
    }
    saveAll(members)
  }

  // An approval of Disperse: mined (and Disperse allowed exactly the batch's
  // total, as the batch is only handed out then), reverted, pending, or
  // replaced.
  private async settleApproval(chain: SendChain, a: Active): Promise<Receipt> {
    const hash = String(a.hash)
    const url = explorerTxUrl(sendChainId(), hash)
    const allowed = async (block: number): Promise<Receipt> => {
      const allowance = await this.onceCaughtUp(
        () => chain.tokenAllowance(DISPERSE_ADDRESS),
        (value) => value.eq(a.amount)
      )
      if (!allowance.eq(a.amount)) {
        return {
          state: "stopped",
          message:
            `The approval ${hash} is mined, but Disperse is allowed ${pnkExact(allowance)}, not the ${pnkExact(a.amount)} asked ` +
            "(was its amount changed in the wallet?). Check again: it asks to approve exactly the total",
        }
      }
      return { state: "confirmed", hash, block, url }
    }
    const pollMs = envInt("SEND_POLL_MS", 2000) || 2000
    for (let tries = 0; ; tries++) {
      const receipt = await chain.receipt(hash)
      if (receipt && receipt.status === 1) return allowed(receipt.blockNumber)
      if (receipt) return { state: "reverted", hash, message: `The approval ${hash} reverted: nothing was approved. Check again.` }
      const latest = await chain.nonce("latest")
      if (a.txNonce === undefined || latest <= a.txNonce) return { state: "pending", hash }
      if (tries >= 3) break
      await sleep(pollMs) // its nonce is used: by it, its receipt not served yet, or by its replacement
    }
    const allowance = await chain.tokenAllowance(DISPERSE_ADDRESS)
    // approved by the wallet's replacement of it
    if (allowance.eq(a.amount)) return { state: "confirmed", hash, block: await chain.blockNumber(), url }
    return {
      state: "stopped",
      message: `The approval ${hash} can no longer be mined (its nonce went to another transaction), and Disperse is allowed ${pnkExact(allowance)}: Check again`,
    }
  }

  // Before a check: everything of this chain and token handed to a wallet and
  // not settled, settled from the chain when it tells (mined, still pending),
  // or listed for the operator with what they may do (a batch once, as one).
  private async settleWalletTransfers(chain: SendChain, account: string, notes: string[]): Promise<UnsettledTransfer[]> {
    const chainId = sendChainId()
    const token = sendTokenAddress().toLowerCase()
    const pinned = pinnedPayer()
    const out: UnsettledTransfer[] = []
    const listed = new Set<string>()
    const records = listDisbursements()
    for (const record of records) {
      if (record.chainId !== chainId || String(record.token).toLowerCase() !== token) continue
      for (const [index, t] of record.transfers.entries()) {
        const sentByWallet = !!t.viaWallet && t.status === "sent"
        if (!isRequested(t) && !sentByWallet) continue
        const batch = !!t.batch
        const key = batch ? `batch:${t.requestId}` : `${record.id}:${index}`
        if (listed.has(key)) continue
        listed.add(key)
        const members = batchIn(records, record, index)
        const ledger = displayPath(recordPath(record))
        const label = describeMembers(members)
        const leave = (why: string, actions: ("hash" | "forget")[]) =>
          out.push({
            ledger,
            recordId: record.id,
            index,
            recipient: t.recipient,
            amount: t.amount,
            from: record.from,
            requestedAt: t.requestedAt,
            requestedNonce: t.requestedNonce,
            ...(batch ? { batch: members.length, total: sumOf(members).toString() } : {}),
            actions,
            why: `${label}: ${why}`,
          })
        if (record.from.toLowerCase() !== account.toLowerCase()) {
          leave(
            pinned && pinned.toLowerCase() !== record.from.toLowerCase()
              ? `handed to the wallet of ${record.from}, not settled: restart the page with SEND_FROM=${record.from} (or without ` +
                  "SEND_FROM), select that account in the wallet and Check, to settle it"
              : `handed to the wallet of ${record.from}, not settled: select that account in the wallet and Check, to settle it`,
            []
          )
          continue
        }
        if (batch) {
          if (members.length !== t.batch) {
            if (members.some((m) => answered(m.t))) {
              leave(`only ${members.length} of its ${t.batch} transfers are in the ledger as handed to the wallet: restore disbursements/ from git`, [])
            } else {
              leave(
                `only ${members.length} of its ${t.batch} transfers were recorded before the page stopped, so the batch never ` +
                  "reached the wallet: mark it as never sent",
                ["forget"]
              )
            }
            continue
          }
          const outcome = await this.settleBatch(chain, members)
          if (outcome.state === "confirmed") {
            notes.push(
              outcome.found
                ? `${label}: the wallet sent it, ${outcome.hash}, mined in block ${outcome.block}`
                : `${label}: paid in block ${outcome.block} (${outcome.hash})${outcome.note ? `: ${outcome.note}` : ""}`
            )
          } else if (outcome.state === "reverted") notes.push(`${label}: ${outcome.message}`)
          else leave(outcome.message, outcome.actions)
          continue
        }
        const expected = expectedFor(members)
        if (isRequested(t) && t.reportedTxHash) {
          const tx = await chain.transactionDetails(t.reportedTxHash)
          if (tx && !transferMismatch(tx, { ...expected, from: record.from, chainId: record.chainId, minNonce: t.requestedNonce })) {
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
              leave(`the wallet answered ${reported} for it, which is not it and is not mined yet: wait until it is, then Check again`, [])
            } else if (tx) {
              leave(
                `the wallet answered ${reported} for it, mined in block ${tx.blockNumber}, which is not this transfer ` +
                  `(${transferMismatch(tx, { ...expected, from: record.from, chainId: record.chainId, minNonce: t.requestedNonce })}), ` +
                  "and nothing pays the transfer. If the wallet's activity shows another hash for it, give that one; otherwise mark it as never sent.",
                ["hash", "forget"]
              )
            } else if (pending > latest || latest <= Number(t.requestedNonce)) {
              leave(
                `the wallet answered ${reported} for it, which the RPC does not know. If the wallet shows it pending, speed it up or ` +
                  "cancel it there, then Check again. If the wallet's activity shows another hash for it, give that one. If it " +
                  `shows nothing, use nonce ${t.requestedNonce}: send any transaction from ${record.from} (a 0-value one to itself); ` +
                  "once nothing pays it, it can be marked as never sent.",
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
                "give its hash if it was sent, or mark it as never sent.",
          ["hash", "forget"]
        )
      }
    }
    return out
  }

  // A transfer paid through a wallet and then paid again by another
  // transaction of the account (same recipient, same amount, after it was
  // handed out): a request approved late, or a transaction marked never sent
  // and sent after all. Each Transfer log pays one transfer: those the ledger
  // does not account for (an unknown transaction, or more logs of a known one
  // than its transfers), nor may yet account for (a transfer not settled),
  // are second payments, each of one transfer. Recorded on the transfer
  // (`paidTwiceBy`: the transaction, once per log of it), and a problem of the
  // check that finds them; what a check recorded is never reported again, on
  // that transfer or another.
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
    type Log = { to: string; amount: string; txHash: string; blockNumber: number }
    const key = (hash: string, to: string, amount: string) => `${hash.toLowerCase()}|${to.toLowerCase()}|${amount}`
    const pays = (f: Log, t: LedgerTransfer) => f.to.toLowerCase() === t.recipient.toLowerCase() && f.amount === t.amount
    // the logs each transaction of the ledger accounts for
    const accounted = new Map<string, number>()
    // the account's transfers sent, or handed to a wallet, and not settled yet
    const unsettled: LedgerTransfer[] = []
    // and those an earlier check found paid a second time
    const recorded: LedgerTransfer[] = []
    for (const r of records) {
      const ofAccount = r.chainId === chainId && String(r.token).toLowerCase() === token && r.from.toLowerCase() === account.toLowerCase()
      for (const t of r.transfers) {
        if (ofAccount && (t.paidTwiceBy || []).length > 0) recorded.push(t)
        if (t.status === "confirmed" && t.txHash) {
          const k = key(t.txHash, t.recipient, t.amount)
          accounted.set(k, (accounted.get(k) || 0) + 1)
        } else if (ofAccount && (t.status === "signed" || t.status === "sent" || isRequested(t))) {
          unsettled.push(t)
        }
      }
    }
    // what is left of each log once the ledger's transfers are accounted for
    const extra: Log[] = []
    const seen = new Map<string, number>()
    for (const f of out) {
      const k = key(f.txHash, f.to, f.amount)
      seen.set(k, (seen.get(k) || 0) + 1)
      if ((seen.get(k) as number) > (accounted.get(k) || 0)) extra.push(f)
    }
    const takeOut = (matches: (f: Log) => boolean): Log | null => {
      const i = extra.findIndex(matches)
      return i < 0 ? null : extra.splice(i, 1)[0]
    }
    // What earlier checks recorded stays where it is: every transfer of the
    // account, watched still or not, takes back a log of each transaction it
    // holds as a second payment, once per time it holds it.
    for (const t of recorded) {
      for (const h of t.paidTwiceBy || []) takeOut((f) => pays(f, t) && f.txHash.toLowerCase() === h.toLowerCase())
    }
    // What pays a transfer not settled yet may be its payment, which only its
    // own settling tells: it is no second payment of an older transfer until
    // then. Each keeps one log out: its own transaction's when the ledger
    // knows one, else one to its recipient for its amount since it was handed
    // out. A log still left over once it is settled is found by the next check.
    const keepOut = (t: LedgerTransfer, own: boolean): boolean => {
      const hashes = ownHashes(t)
      return !!takeOut((f) =>
        own ? pays(f, t) && hashes.has(f.txHash.toLowerCase()) : pays(f, t) && (t.requestedBlock === undefined || f.blockNumber >= t.requestedBlock)
      )
    }
    for (const t of unsettled.filter((u) => !keepOut(u, true))) keepOut(t, false)
    // The rest is new: one log, one second payment, of one transfer. A
    // transaction pays a transfer again once, so two transfers to one
    // recipient for one amount, paid again by one transaction (a batch sent
    // twice), are two second payments, one each. Logs left after that (more of
    // one transaction than transfers it could pay again) go to the first
    // transfer they pay again: none is dropped.
    const found = new Map<LedgerTransfer, Log[]>()
    const paysAgain = (f: Log, t: LedgerTransfer) => pays(f, t) && f.blockNumber > Number(t.requestedBlock)
    for (const { t } of watched) {
      const held = new Set((t.paidTwiceBy || []).map((h) => h.toLowerCase()))
      for (;;) {
        const f = takeOut((x) => paysAgain(x, t) && !held.has(x.txHash.toLowerCase()))
        if (!f) break
        held.add(f.txHash.toLowerCase())
        found.set(t, (found.get(t) || []).concat(f))
      }
    }
    for (const { t } of watched) {
      for (;;) {
        const f = takeOut((x) => paysAgain(x, t))
        if (!f) break
        found.set(t, (found.get(t) || []).concat(f))
      }
    }
    for (const { record, t } of watched) {
      const again = found.get(t) || []
      if (again.length === 0) continue
      t.paidTwiceBy = (t.paidTwiceBy || []).concat(again.map((f) => f.txHash.toLowerCase()))
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
    const { requestedAt, requestedNonce, requestedBlock, requestId, batch, batchIndex } = t
    clearTransaction(t)
    Object.assign(t, { requestedAt, requestedNonce, requestedBlock, requestId, batch, batchIndex })
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
  }}
