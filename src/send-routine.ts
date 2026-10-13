import { BigNumber, utils } from "ethers"
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs"
import { isAbsolute, join, relative, resolve, sep } from "path"
import conf from "./config"
import { humanizeAmount } from "./transaction-sender"
import { GenerateManifest, RemovalsManifest } from "./types"
import { chainDisplayName } from "./utils/chains"
import {
  acquireDisbursementLock,
  contentId,
  disbursementId,
  disbursementsDir,
  DisbursementKind,
  DisbursementRecord,
  displayPath,
  fileSha256,
  LedgerTransfer,
  listDisbursements,
  periodLabel,
  recordPath,
  saveDisbursement,
} from "./utils/disbursement-ledger"
import { envInt, sleep } from "./utils/runtime-helpers"
import { createSendChain, explorerTxUrl, Fees, OnchainTransfer, SendChain, sendChainId, sendTokenAddress } from "./utils/send-chain"

// `--mode send`: pays a transactions file ([{ recipient, amount }], written by
// generate and removals) in PNK, one transfer at a time, recording every step
// in the disbursement ledger (utils/disbursement-ledger.ts):
// - refused: a payout already disbursed (same transfers, kind and period), a
//   file paying exactly what another one paid unless both are clearly other
//   payouts (other months, or other kinds of one month), another file for a
//   period and kind already paid, and transfers that repeat ones already paid
//   (found on-chain: another machine, a run before the ledger, or a ledger
//   payout that may be this one), a new payout whose period is unknown
//   (no manifest gives it: --period states it, which never proves a payout
//   differs from another), a period not over yet, and a ledger record that no
//   longer matches its own ids;
// - each transfer's transaction is signed and saved before it is broadcast,
//   then waited for: a run stopped anywhere resumes where it was, and a
//   transfer is never paid twice;
// - --dry-run shows all of it without signing anything.

export interface SendOptions {
  file: string
  dryRun?: boolean
  // Send although another file for the same period and kind, or another file
  // paying exactly the same transfers, was paid.
  allowRepeatPeriod?: boolean
  // Count transfers found on-chain as paid and send the rest.
  skipPaidOnChain?: boolean
  // Do not look for this payout's transfers on-chain.
  skipOnchainCheck?: boolean
  // Send again a transfer whose saved transactions can no longer be mined:
  // the wallet's nonce they hold went to another transaction.
  forgetUnmined?: boolean
  // Dry run only: check as this address, without its key.
  from?: string
  // The month (YYYY-MM) the file pays, for a file no manifest gives the period of.
  period?: string
}

export interface SendResult {
  record: DisbursementRecord | null
  sent: number // transfers confirmed by this run
  path: string | null // the ledger file
}

// A send that must not go ahead, with why and what to do.
export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SendRefusedError"
  }
}

interface PlannedTransfer {
  recipient: string
  amount: BigNumber
}

interface Source {
  kind: DisbursementKind
  periodStart?: string
  periodEnd?: string
  // Stated with --period, no manifest giving it: enough for the period rule,
  // never proof that this payout differs from another one.
  periodStated?: boolean
  manifest?: string
}

const pnk = (wei: BigNumber | string): string => `${humanizeAmount(BigNumber.from(wei))} PNK`
const sumOf = (amounts: (BigNumber | string)[]): BigNumber =>
  amounts.reduce<BigNumber>((acc, a) => acc.add(a), BigNumber.from(0))

const sendSettings = (): {
  fees: Fees
  receiptTimeoutMs: number
  pollMs: number
  lookbackDays: number
  countdownSeconds: number
} => {
  const gwei = (name: string, fallback: string): BigNumber => {
    const raw = String(process.env[name] || "").trim() || fallback
    try {
      const value = utils.parseUnits(raw, "gwei")
      if (value.lte(0)) throw new Error("not positive")
      return value
    } catch {
      throw new Error(`Invalid ${name}="${raw}": expected a positive number of gwei`)
    }
  }
  const fees: Fees = {
    maxFeePerGas: gwei("SEND_MAX_FEE_GWEI", "2"),
    maxPriorityFeePerGas: gwei("SEND_MAX_PRIORITY_FEE_GWEI", "1"),
    gasLimit: BigNumber.from(envInt("SEND_GAS_LIMIT", 100000) || 100000),
  }
  if (fees.maxPriorityFeePerGas.gt(fees.maxFeePerGas)) {
    throw new Error("SEND_MAX_PRIORITY_FEE_GWEI must not exceed SEND_MAX_FEE_GWEI")
  }
  const timeoutRaw = String(process.env.SEND_RECEIPT_TIMEOUT_SECONDS || "").trim() || "300"
  const timeoutSeconds = Number(timeoutRaw)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid SEND_RECEIPT_TIMEOUT_SECONDS="${timeoutRaw}": expected a positive number of seconds`)
  }
  return {
    fees,
    receiptTimeoutMs: Math.round(timeoutSeconds * 1000),
    pollMs: envInt("SEND_POLL_MS", 2000) || 2000,
    lookbackDays: envInt("SEND_ONCHAIN_LOOKBACK_DAYS", 45) || 45,
    countdownSeconds: envInt("SEND_COUNTDOWN_SECONDS", 10),
  }
}

// The transfers of a transactions file, validated. Zero amounts are left out.
export const readTransactionsFile = (
  path: string
): { transfers: PlannedTransfer[]; skippedZero: number; duplicates: string[] } => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path).toString())
  } catch (err) {
    throw new SendRefusedError(`${displayPath(path)} is not valid JSON (${err}).`)
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SendRefusedError(`${displayPath(path)} is not a transactions file: expected a non-empty array of { recipient, amount }.`)
  }
  const transfers: PlannedTransfer[] = []
  const seen = new Set<string>()
  const duplicates: string[] = []
  let skippedZero = 0
  raw.forEach((value: unknown, i: number) => {
    const at = `${displayPath(path)}[${i}]`
    if (!value || typeof value !== "object") throw new SendRefusedError(`${at} is not an object.`)
    const entry = value as { recipient?: unknown; amount?: unknown }
    if ("registry" in entry || "tagAddress" in entry || "kind" in entry || "itemID" in entry) {
      throw new SendRefusedError(
        `${at} has reward-record fields: this looks like a *_rewards.json / *_removals.json / *_atq.json record file. ` +
          "Pass the transactions file: <runId>.json, <runId>_removals_transactions.json or <runId>_atq_transactions.json."
      )
    }
    const recipient = String(entry.recipient || "")
    if (!utils.isAddress(recipient) || BigNumber.from(utils.getAddress(recipient)).isZero()) {
      throw new SendRefusedError(`${at} has an invalid recipient "${recipient}".`)
    }
    let amount: BigNumber
    try {
      amount = BigNumber.from(entry.amount)
    } catch {
      throw new SendRefusedError(`${at} has an invalid amount ${JSON.stringify(entry.amount)} (expected wei).`)
    }
    if (amount.isNegative()) throw new SendRefusedError(`${at} has a negative amount.`)
    if (amount.isZero()) {
      skippedZero++
      return
    }
    const key = recipient.toLowerCase()
    if (seen.has(key)) duplicates.push(recipient)
    seen.add(key)
    transfers.push({ recipient: utils.getAddress(recipient), amount })
  })
  if (transfers.length === 0) throw new SendRefusedError(`${displayPath(path)} pays nothing: every amount is 0.`)
  return { transfers, skippedZero, duplicates }
}

// Which run wrote the file, from the manifests next to it: the kind of payout
// and its period. Files of old runs (no period in their manifest) and
// hand-made files get "unknown" where it cannot be told.
export const resolveSource = (file: string): Source => {
  const dir = `./${conf.FILES_DIR}`
  const names = existsSync(dir) ? readdirSync(dir) : []
  const read = <T>(name: string): T | null => {
    try {
      return JSON.parse(readFileSync(join(dir, name)).toString()) as T
    } catch {
      return null
    }
  }
  const found: Source[] = []
  for (const name of names) {
    if (/(^|_)generate_manifest\.json$/.test(name)) {
      const m = read<GenerateManifest>(name)
      if (m && m.transactionsFile === file) {
        found.push({ kind: "submissions", periodStart: m.periodStart, periodEnd: m.periodEnd, manifest: name })
      }
    } else if (/(^|_)removals_manifest\.json$/.test(name)) {
      const m = read<RemovalsManifest>(name)
      if (!m) continue
      const kind = m.transactionsFile === file ? "removals" : m.atqTransactionsFile === file ? "atq" : null
      if (kind) found.push({ kind, periodStart: m.periodStart, periodEnd: m.periodEnd, manifest: name })
    }
  }
  const withPeriod = found.find((s) => s.periodStart && s.periodEnd)
  if (withPeriod) return withPeriod
  if (found.length > 0) return { kind: found[0].kind, manifest: found[0].manifest }
  if (/_removals_transactions\.json$/.test(file)) return { kind: "removals" }
  if (/_atq_transactions\.json$/.test(file)) return { kind: "atq" }
  if (/^\d+\.json$/.test(file)) return { kind: "submissions" }
  return { kind: "unknown" }
}

// The transactions file's name in FILES_DIR, however it was given ("x.json",
// "./x.json", "files/x.json", an absolute path, another letter case): the
// manifests name it so, and a spelling that missed them would lose the
// payout's period, and with it the refusal of a second payout of that month.
export const transactionsFileName = (file: string): string => {
  const dir = resolve(conf.FILES_DIR)
  const given = [resolve(dir, file), resolve(file)].find((path) => existsSync(path))
  if (!given) {
    throw new SendRefusedError(
      `./${conf.FILES_DIR}/${file} not found. Pass the transactions file's name inside ${conf.FILES_DIR}/ (generate and removals print it).`
    )
  }
  const name = relative(realpathSync.native(dir), realpathSync.native(given))
  if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new SendRefusedError(`${file} is not a file in ${conf.FILES_DIR}/: send pays files from there, next to the manifests that give their period.`)
  }
  return name.split(sep).join("/")
}

// --period YYYY-MM: the calendar month (UTC) a file pays.
const statedPeriod = (label: string): { periodStart: string; periodEnd: string } => {
  const match = /^(\d{4})-(\d{2})$/.exec(label.trim())
  const month = match ? Number(match[2]) : 0
  if (!match || month < 1 || month > 12) throw new SendRefusedError(`Invalid --period "${label}". Expected YYYY-MM.`)
  const year = Number(match[1])
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    periodEnd: new Date(Date.UTC(year, month, 1)).toISOString(),
  }
}

// The file's source, with the month --period states when no manifest gives one.
const sourceOf = (name: string, period?: string): Source => {
  const source = resolveSource(name)
  if (!period) return source
  const stated = statedPeriod(period)
  if (source.periodStart && source.periodEnd) {
    if (Date.parse(source.periodStart) !== Date.parse(stated.periodStart) || Date.parse(source.periodEnd) !== Date.parse(stated.periodEnd)) {
      throw new SendRefusedError(
        `--period ${period.trim()} contradicts ${source.manifest}, which gives ${periodLabel(source.periodStart, source.periodEnd)} for ${name}.`
      )
    }
    return source
  }
  return { ...source, ...stated, periodStated: true }
}

type Payout = { kind: string; periodStart?: string; periodEnd?: string; periodStated?: boolean }

const describePayout = (record: Payout & { file: string }): string => {
  const period = periodLabel(record.periodStart, record.periodEnd)
  return `${record.kind} for ${period === "unknown" ? "an unknown period" : period} (${record.file})`
}

const describeRecord = (r: DisbursementRecord): string => {
  const confirmed = r.transfers.filter((t) => t.status === "confirmed").length
  const state = r.status === "completed" ? `disbursed${r.completedAt ? ` on ${r.completedAt.slice(0, 10)}` : ""}` : "in progress"
  return `${describePayout(r)}: ${state}, ${confirmed}/${r.transfers.length} transfers, ${pnk(r.total)}, in ${displayPath(recordPath(r))}`
}

const overlaps = (a: Payout, b: Payout): boolean =>
  !!(a.periodStart && a.periodEnd && b.periodStart && b.periodEnd) &&
  Date.parse(a.periodStart) < Date.parse(b.periodEnd) &&
  Date.parse(b.periodStart) < Date.parse(a.periodEnd)

// A file of unknown kind may be any of them.
const sameKind = (a: string, b: string): boolean => a === "unknown" || b === "unknown" || a === b

// Two payouts that can legitimately pay the same transfer twice: other
// months, or other kinds of one month (one address owed 500 PNK as remover
// and as ATQ requester). Unknown periods prove nothing, and neither does a
// period stated with --period: a wrong month typed there must not pass a paid
// file, or the transfers it paid, as another month's.
const distinctPayouts = (a: Payout, b: Payout): boolean => {
  if (!a.periodStart || !a.periodEnd || !b.periodStart || !b.periodEnd) return false
  if (a.periodStated || b.periodStated) return false
  if (!overlaps(a, b)) return true
  return a.kind !== "unknown" && b.kind !== "unknown" && a.kind !== b.kind
}

// The transactions that may have paid a transfer (reverted ones paid nothing).
const paidHashes = (t: LedgerTransfer): string[] =>
  (t.attempts || []).concat(t.txHash ? [t.txHash] : []).map((h) => h.toLowerCase())

const hasLiveTx = (t: LedgerTransfer): boolean => t.status === "signed" || t.status === "sent"

interface Funds {
  toFund: LedgerTransfer[] // the transfers that still need the wallet's PNK and gas
  due: BigNumber
  gasNeeded: BigNumber
  balance: BigNumber
  native: BigNumber
  baseFee: BigNumber | null
}

// What the transfers not confirmed yet still need from the wallet. A saved
// transaction whose nonce the wallet has used needs nothing more: it was
// mined (its PNK gone, though its receipt may be missing), or another
// transaction took its nonce and sending stops at it (--forget-unmined sends
// it anew, after checking the funds again).
const fundsFor = async (chain: SendChain, transfers: LedgerTransfer[], fees: Fees): Promise<Funds> => {
  const usedNonces = await chain.nonce("latest")
  const toFund = transfers.filter(
    (t) => t.status !== "confirmed" && !(hasLiveTx(t) && t.nonce !== undefined && t.nonce < usedNonces)
  )
  const [balance, native, baseFee] = await Promise.all([chain.tokenBalance(), chain.nativeBalance(), chain.baseFee()])
  return {
    toFund,
    due: sumOf(toFund.map((t) => t.amount)),
    gasNeeded: fees.gasLimit.mul(fees.maxFeePerGas).mul(toFund.length),
    balance,
    native,
    baseFee,
  }
}

// Why the wallet cannot pay them (a transfer sent without the PNK reverts,
// its gas lost), or null.
const shortfall = (funds: Funds, fees: Fees): string | null => {
  if (funds.toFund.length === 0) return null
  if (funds.balance.lt(funds.due)) return `the wallet holds ${pnk(funds.balance)}, less than the ${pnk(funds.due)} to send.`
  if (funds.native.lt(funds.gasNeeded)) {
    return (
      `the wallet holds ${utils.formatEther(funds.native)} of the chain's native token for gas, ` +
      `less than the ${utils.formatEther(funds.gasNeeded)} these transfers may use.`
    )
  }
  if (funds.baseFee && funds.baseFee.gt(fees.maxFeePerGas)) {
    return (
      `the base fee is ${utils.formatUnits(funds.baseFee, "gwei")} gwei, above SEND_MAX_FEE_GWEI ` +
      `(${utils.formatUnits(fees.maxFeePerGas, "gwei")}); transactions would not be mined. Raise it and rerun.`
    )
  }
  return null
}

export const sendRoutine = async (
  opts: SendOptions,
  deps: { chain?: SendChain; log?: (line: string) => void } = {}
): Promise<SendResult> => {
  const log = deps.log || ((line: string) => console.log(line))
  if (opts.from && !opts.dryRun) throw new SendRefusedError("--from only works with --dry-run: sending needs WALLET_PRIVATE_KEY")
  const settings = sendSettings()
  const { fees } = settings
  const name = transactionsFileName(opts.file)
  const path = `./${conf.FILES_DIR}/${name}`
  const { transfers, skippedZero, duplicates } = readTransactionsFile(path)
  const chainId = deps.chain ? deps.chain.chainId : sendChainId()
  const token = deps.chain ? deps.chain.token : sendTokenAddress()
  const planned = transfers.map((t) => ({ recipient: t.recipient, amount: t.amount.toString() }))
  const source = sourceOf(name, opts.period)
  const content = contentId(chainId, token, planned)
  const id = disbursementId(content, source.kind, source.periodStart, source.periodEnd)
  const total = sumOf(transfers.map((t) => t.amount))

  log(`=== ${opts.dryRun ? "Dry run: " : ""}send ${name} ===`)
  const sourceNote = source.periodStated ? ", period stated with --period" : source.manifest ? `, from ${source.manifest}` : ""
  log(`Payout: ${describePayout({ ...source, file: name })}${sourceNote}`)
  // A period is paid once it is over. One still running is a mistake (most
  // likely the current month typed for the last one), and the on-chain check
  // would read its transfers from a date to come: none.
  if (source.periodEnd && Date.parse(source.periodEnd) > Date.now()) {
    throw new SendRefusedError(
      `Refusing to send: ${name} pays ${periodLabel(source.periodStart, source.periodEnd)}, which only ends on ` +
        `${source.periodEnd.slice(0, 10)}${source.periodStated ? ": check the month given to --period" : ""}. ` +
        "Rewards are paid once their period is over. Nothing was sent."
    )
  }
  log(`Network: ${chainDisplayName(String(chainId))} (${chainId}), token PNK ${token}`)
  log(`Transfers: ${transfers.length}, total ${pnk(total)}`)
  if (skippedZero > 0) log(`(${skippedZero} zero-amount entr${skippedZero === 1 ? "y" : "ies"} left out)`)
  if (duplicates.length > 0) log(`WARNING: recipients listed more than once (each entry is paid): ${duplicates.join(", ")}`)

  const release = opts.dryRun ? () => undefined : acquireDisbursementLock()
  try {
    // --- the ledger -------------------------------------------------------
    // Records of other chains or tokens (a testnet trial) concern other funds.
    const records = listDisbursements().filter(
      (r) => r.chainId === chainId && String(r.token).toLowerCase() === token.toLowerCase()
    )
    // This payout's record: the same id, or an unfinished record paying exactly
    // the same transfers that this file cannot be told apart from (a period
    // unknown on one side: the manifests stay in files/, which another machine
    // may not have).
    let record = records.find((r) => r.id === id) || null
    if (!record) {
      const sameUnfinished = records.filter(
        (r) => r.status === "in-progress" && r.contentId === content && !distinctPayouts(source, r)
      )
      if (sameUnfinished.length > 1) {
        throw new SendRefusedError(
          `Refusing to send: ${sameUnfinished.map(describeRecord).join("; ")} all pay exactly these transfers and are unfinished. ` +
            `Resume each one with its own file, its manifest next to it in ${conf.FILES_DIR}/.`
        )
      }
      record = sameUnfinished[0] || null
      if (
        record &&
        source.periodStated &&
        record.periodStart &&
        record.periodEnd &&
        (Date.parse(record.periodStart) !== Date.parse(source.periodStart as string) ||
          Date.parse(record.periodEnd) !== Date.parse(source.periodEnd as string))
      ) {
        throw new SendRefusedError(
          `Refusing to send: --period ${String(opts.period).trim()} contradicts ${describeRecord(record)}, an unfinished payout of ` +
            `exactly these transfers. If ${name} is that payout, finish it without --period. Nothing was sent.`
        )
      }
      if (record) log(`Ledger: this file pays exactly what an unfinished payout pays: ${describeRecord(record)}`)
    }
    if (record && record.status === "completed") {
      throw new SendRefusedError(`Refusing to send: this payout was already disbursed. ${describeRecord(record)}. Nothing was sent.`)
    }
    const others = records.filter((r) => r !== record)
    // Another payout with transactions in flight holds nonces of the wallet;
    // one merely left half-paid does not, but should be finished.
    const unfinished = others.filter((r) => r.status === "in-progress")
    const inFlight = unfinished.filter((r) => r.transfers.some(hasLiveTx))
    if (inFlight.length > 0) {
      throw new SendRefusedError(
        `Refusing to send: ${inFlight.map(describeRecord).join("; ")}, has transactions in flight. ` +
          "Rerun send on that file first, so two payouts never share the wallet's nonces."
      )
    }
    for (const r of unfinished.filter((u) => !inFlight.includes(u))) log(`WARNING: not finished: ${describeRecord(r)}. Rerun send on it.`)
    if (!record && !opts.allowRepeatPeriod) {
      // A copy of a paid file under another name (its period then unknown),
      // or a corrected file for a period and kind already paid.
      const sameContent = others.filter((r) => r.contentId === content && !distinctPayouts(source, r))
      if (sameContent.length > 0) {
        throw new SendRefusedError(
          `Refusing to send: this file pays exactly the same transfers as ${sameContent.map(describeRecord).join("; ")}: ` +
            "it was already disbursed under that name. If paying them again is deliberate, rerun with --allow-repeat-period."
        )
      }
      const samePeriod = others.filter((r) => sameKind(source.kind, r.kind) && overlaps(source, r))
      if (samePeriod.length > 0) {
        throw new SendRefusedError(
          `Refusing to send: ${samePeriod.map(describeRecord).join("; ")}. Paying ${name} too would pay that period twice; ` +
            "rewards are pool-based, so a corrected file is not a top-up. If it is a deliberate extra payout, rerun with --allow-repeat-period."
        )
      }
    }
    // A new payout must know its month: without it nothing tells a corrected
    // file (other amounts) from a second payout of a month already paid.
    const mustKnowPeriod = !record && !(source.periodStart && source.periodEnd) && !opts.allowRepeatPeriod
    const unknownPeriod = () =>
      new SendRefusedError(
        `Refusing to send: the period of ${name} is unknown (no manifest in ${conf.FILES_DIR}/ gives it), so send cannot tell it ` +
          "from a second payout of a month already paid: a corrected file pays other amounts, which neither the ledger nor the " +
          "chain recognizes. Rerun with --period YYYY-MM, the month it pays, or with --allow-repeat-period for a payout outside " +
          "the monthly ones. Nothing was sent."
      )
    if (record) {
      const done = record.transfers.filter((t) => t.status === "confirmed").length
      log(`Ledger: resuming ${displayPath(recordPath(record))}, ${done}/${record.transfers.length} transfers already confirmed`)
    } else {
      log("Ledger: not disbursed before")
    }

    // --- the chain --------------------------------------------------------
    let chain: SendChain
    try {
      chain = deps.chain || createSendChain({ readOnlyFrom: opts.from })
    } catch (err) {
      // A dry run without a key still checks the file and the ledger.
      if (!opts.dryRun || opts.from) throw err
      if (mustKnowPeriod) throw unknownPeriod()
      log(`Skipping the wallet and on-chain checks: ${(err as Error).message}`)
      return { record, sent: 0, path: record ? recordPath(record) : null }
    }
    const network = await chain.networkChainId()
    if (network !== chainId) {
      throw new SendRefusedError(`The RPC answers for chain ${network}, not TX_NETWORK_ID=${chainId}. Check TX_RPC_URL.`)
    }
    log(`From: ${chain.from}`)
    if (record && record.from.toLowerCase() !== chain.from.toLowerCase()) {
      throw new SendRefusedError(
        `Refusing to send: ${displayPath(recordPath(record))} was started from ${record.from}, and WALLET_PRIVATE_KEY is now ` +
          `${chain.from}. Its signed transactions belong to that wallet: finish it with the same key.`
      )
    }
    const now = new Date().toISOString()
    const current: DisbursementRecord = record || {
      version: 1,
      id,
      contentId: content,
      file: name,
      fileSha256: fileSha256(path),
      kind: source.kind,
      ...(source.periodStart && source.periodEnd ? { periodStart: source.periodStart, periodEnd: source.periodEnd } : {}),
      ...(source.periodStated ? { periodStated: true } : {}),
      chainId,
      token,
      from: chain.from,
      status: "in-progress",
      total: total.toString(),
      createdAt: now,
      updatedAt: now,
      transfers: planned.map((t) => ({ ...t, status: "pending" as const })),
    }
    const save = (): void => {
      if (!opts.dryRun) saveDisbursement(current)
    }

    // Transactions of an earlier run, already mined, are settled first.
    for (const t of current.transfers) {
      if (hasLiveTx(t)) await settle(chain, t)
    }

    // --- already paid? ----------------------------------------------------
    // The wallet's PNK transfers since the period ended (or the last
    // SEND_ONCHAIN_LOOKBACK_DAYS): one to the same recipient for the same
    // amount repeats a transfer of this file, unless the ledger shows it paid
    // a clearly different payout (another month, another kind).
    const open = current.transfers.filter((t) => t.status === "pending" || t.status === "failed")
    if (open.length > 0 && !opts.skipOnchainCheck) {
      const since = current.periodEnd
        ? Math.floor(Date.parse(current.periodEnd) / 1000)
        : Math.floor(Date.now() / 1000) - settings.lookbackDays * 86400
      let found: OnchainTransfer[]
      try {
        found = await chain.outgoingTransfers(since)
      } catch (err) {
        throw new SendRefusedError(
          `Could not read the wallet's past PNK transfers to check this payout is not paid already ` +
            `(${(err as Error).message}). Retry, use another TX_RPC_URL, or rerun with --skip-onchain-check.`
        )
      }
      const own = new Set(current.transfers.flatMap(paidHashes))
      // This payout's transactions recorded as reverted or never mined: one
      // found paying on-chain is its own all the same, never a stranger's.
      const ownPast = new Set(
        current.transfers.flatMap((t) => (t.revertedTxs || []).concat(t.forgottenTxs || [])).map((h) => h.toLowerCase())
      )
      const holder = new Map<string, DisbursementRecord>()
      for (const r of others) for (const t of r.transfers) for (const hash of paidHashes(t)) holder.set(hash, r)
      const candidates = found.filter((f) => {
        const hash = f.txHash.toLowerCase()
        if (own.has(hash)) return false
        const r = holder.get(hash)
        return !r || !distinctPayouts(current, r)
      })
      const matches: { transfer: LedgerTransfer; tx: OnchainTransfer }[] = []
      for (const t of open) {
        const i = candidates.findIndex((f) => f.to.toLowerCase() === t.recipient.toLowerCase() && f.amount === t.amount)
        if (i >= 0) matches.push({ transfer: t, tx: candidates.splice(i, 1)[0] })
      }
      const sinceText = new Date(since * 1000).toISOString().slice(0, 10)
      if (matches.length === 0) {
        log(`Already paid: none of these transfers is among the wallet's PNK transfers since ${sinceText}`)
      } else {
        const lines = await Promise.all(
          matches.slice(0, 20).map(async ({ transfer, tx }) => {
            const at = await chain.blockTimestamp(tx.blockNumber)
            const date = at === null ? "date unknown" : new Date(at * 1000).toISOString().slice(0, 10)
            const r = holder.get(tx.txHash.toLowerCase())
            const origin = r
              ? `paid by ${describePayout(r)}, ${displayPath(recordPath(r))}`
              : ownPast.has(tx.txHash.toLowerCase())
              ? "this payout's own transaction, recorded as reverted or never mined, yet it paid"
              : "unknown to the ledger"
            return `  ${pnk(transfer.amount)} to ${transfer.recipient}: tx ${tx.txHash} (block ${tx.blockNumber}, ${date}; ${origin})`
          })
        )
        if (matches.length > 20) lines.push(`  … and ${matches.length - 20} more`)
        // Refused either way: identical capped amounts can coincide (one address
        // owed 500 PNK twice), so only the operator can say they are this file's.
        if (!opts.skipPaidOnChain) {
          const all = matches.length === open.length && current.transfers.every((t) => t.status === "confirmed" || open.includes(t))
          throw new SendRefusedError(
            (all
              ? `Refusing to send: every remaining transfer of this payout is already paid since ${sinceText}:\n${lines.join("\n")}\n` +
                "If they are this file's (paid from another machine, or before the ledger), rerun with --skip-paid-on-chain to " +
                "record it as paid. If they only coincide with it, rerun with --skip-onchain-check to send it."
              : `Refusing to send: ${matches.length} of the ${open.length} transfers to send repeat transfers this wallet already paid ` +
                `since ${sinceText} (same recipient, same amount):\n${lines.join("\n")}\n` +
                "Another machine, a run before the ledger, or a payout listed above may have paid part of this file. Rerun with " +
                "--skip-paid-on-chain to count those as paid and send the rest, or with --skip-onchain-check to send everything anyway.") +
              " Nothing was sent."
          )
        }
        log(`Already paid: ${matches.length} transfer(s), counted as paid (--skip-paid-on-chain):\n${lines.join("\n")}`)
        for (const { transfer, tx } of matches) {
          transfer.status = "confirmed"
          transfer.txHash = tx.txHash
          transfer.blockNumber = tx.blockNumber
          transfer.confirmedAt = now
          transfer.foundOnChain = true
        }
      }
    }

    const toSend = current.transfers.filter((t) => t.status !== "confirmed")
    if (mustKnowPeriod && toSend.length > 0) throw unknownPeriod()

    // --- funds ----------------------------------------------------------
    const funds = await fundsFor(chain, current.transfers, fees)
    const { due, gasNeeded } = funds
    log(
      `Balance: ${pnk(funds.balance)} for ${pnk(due)} still to send; ${utils.formatEther(funds.native)} native for gas ` +
        `(up to ${utils.formatEther(gasNeeded)})`
    )
    if (funds.toFund.length < toSend.length) {
      log(`(not counted: ${toSend.length - funds.toFund.length} saved transaction(s) whose nonce the wallet has used, checked next)`)
    }
    const short = shortfall(funds, fees)
    if (short) throw new SendRefusedError(`Refusing to send: ${short}`)
    for (const [i, t] of current.transfers.entries()) {
      log(`  #${i + 1} ${pnk(t.amount).padStart(16)} → ${t.recipient}  ${t.status === "confirmed" ? `paid (${t.txHash})` : t.status}`)
    }
    if (opts.dryRun) {
      log(`Dry run: would send ${toSend.length} transfer(s), ${pnk(due)}. Nothing was signed or recorded.`)
      return { record: current, sent: 0, path: null }
    }
    if (toSend.length === 0) {
      current.status = "completed"
      current.completedAt = current.completedAt || new Date().toISOString()
      save()
      log(`Every transfer is confirmed: recorded as disbursed in ${displayPath(recordPath(current))}`)
      return { record: current, sent: 0, path: recordPath(current) }
    }
    if (process.stdout.isTTY && settings.countdownSeconds > 0) {
      log(`Sending ${toSend.length} transfer(s) in ${settings.countdownSeconds} s (Ctrl+C to stop)…`)
      await sleep(settings.countdownSeconds * 1000)
    }
    save()
    const ledgerPath = displayPath(recordPath(current))
    log(`Ledger: ${ledgerPath}`)

    // --- sending ----------------------------------------------------------
    let nextNonce = Math.max(
      await chain.nonce("pending"),
      ...current.transfers.filter((t) => t.nonce !== undefined).map((t) => (t.nonce as number) + 1)
    )
    let sent = 0
    // Saved transactions first, lowest nonce first: a higher one cannot be
    // mined before every lower one is.
    const order = toSend
      .filter(hasLiveTx)
      .sort((a, b) => (a.nonce as number) - (b.nonce as number))
      .concat(toSend.filter((t) => !hasLiveTx(t)))
    const context: SendContext = {
      chain,
      fees,
      settings,
      save,
      log,
      forgetUnmined: !!opts.forgetUnmined,
      skipPaidOnChain: !!opts.skipPaidOnChain,
      startedAt: current.createdAt,
      checkFunds: async (label) => {
        const missing = shortfall(await fundsFor(chain, current.transfers, fees), fees)
        if (missing) throw new SendRefusedError(`${label}: not sending it again: ${missing}`)
      },
      known: new Set(records.concat(current).flatMap((r) => r.transfers.flatMap(paidHashes))),
    }
    try {
      for (const t of order) {
        const index = current.transfers.indexOf(t) + 1
        const label = `[${index}/${current.transfers.length}] ${pnk(t.amount)} → ${t.recipient}`
        // A transfer forgotten by --forget-unmined goes out again as a new
        // one, if the wallet still covers it and the rest.
        const live = hasLiveTx(t)
        const resend = live ? await resumeTransfer(context, t, label) : true
        if (resend && live) await context.checkFunds(label)
        if (resend) nextNonce = await sendNew(context, t, nextNonce, label)
        sent++
        const url = explorerTxUrl(chainId, t.txHash as string)
        log(`${label}: confirmed in block ${t.blockNumber}${url ? ` ${url}` : ` (tx ${t.txHash})`}`)
      }
    } catch (err) {
      const error = err as Error
      error.message +=
        `\nProgress is saved in ${ledgerPath}: rerun the same command to continue. ` +
        "Transfers already sent are waited for or rebroadcast as signed, never sent again."
      throw error
    }
    current.status = "completed"
    current.completedAt = new Date().toISOString()
    save()
    log(
      `Done: ${current.transfers.length} transfers confirmed, ${pnk(current.total)}. Recorded in ${ledgerPath}; ` +
        "commit it (like exclusions.json) so other machines refuse to pay this file again."
    )
    return { record: current, sent, path: recordPath(current) }
  } finally {
    release()
  }
}

type Settings = ReturnType<typeof sendSettings>
type Outcome = "confirmed" | "reverted" | "pending"

interface SendContext {
  chain: SendChain
  fees: Fees
  settings: Settings
  save: () => void
  log: (line: string) => void
  forgetUnmined: boolean
  skipPaidOnChain: boolean
  startedAt: string // when this payout's record was created
  checkFunds: (label: string) => Promise<void> // throws when the wallet no longer covers what is left to send
  known: Set<string> // every transaction hash the ledger holds for this chain, and those this run signs
}

// Checks a transfer's transactions for a receipt: confirmed, reverted (the
// transfer can be sent again, with a new nonce), or still unknown.
const settle = async (chain: SendChain, t: LedgerTransfer): Promise<Outcome> => {
  for (const hash of t.attempts && t.attempts.length > 0 ? t.attempts : t.txHash ? [t.txHash] : []) {
    const receipt = await chain.receipt(hash)
    if (!receipt) continue
    if (receipt.status === 1) {
      t.status = "confirmed"
      t.txHash = hash
      t.blockNumber = receipt.blockNumber
      t.confirmedAt = new Date().toISOString()
      delete t.rawTx
      return "confirmed"
    }
    t.revertedTxs = (t.revertedTxs || []).concat(hash)
    clearTransaction(t)
    t.status = "failed"
    return "reverted"
  }
  return "pending"
}

const clearTransaction = (t: LedgerTransfer): void => {
  delete t.nonce
  delete t.txHash
  delete t.rawTx
  delete t.attempts
  delete t.maxFeePerGas
  delete t.maxPriorityFeePerGas
}

// Polls for a receipt until `timeoutMs`; an RPC error only stops it at the end.
const waitForSettle = async (chain: SendChain, t: LedgerTransfer, timeoutMs: number, pollMs: number): Promise<Outcome> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let outcome: Outcome = "pending"
    try {
      outcome = await settle(chain, t)
    } catch (err) {
      if (Date.now() >= deadline) throw err
    }
    if (outcome !== "pending" || Date.now() >= deadline) return outcome
    await sleep(pollMs)
  }
}

const finish = (outcome: Outcome, t: LedgerTransfer, label: string, ctx: SendContext): void => {
  ctx.save()
  if (outcome === "confirmed") return
  if (outcome === "reverted") {
    const tx = (t.revertedTxs || []).slice(-1)[0]
    throw new Error(`${label}: transaction ${tx} reverted, so nothing was paid by it. Stopped; fix the cause, then rerun to send it again.`)
  }
  throw new Error(
    `${label}: transaction ${t.txHash} (nonce ${t.nonce}) was not mined within ${ctx.settings.receiptTimeoutMs / 1000} s. Stopped; ` +
      "rerun to keep waiting (the same signed transaction is rebroadcast), or raise SEND_MAX_FEE_GWEI first to replace it with higher fees."
  )
}

// The node refused a transaction without taking it: it stays saved as signed
// (another node may still have it), and the run stops with what to do.
const refusedBroadcast = (result: "replacement-underpriced" | "underpriced", t: LedgerTransfer, label: string, ctx: SendContext): never => {
  ctx.save()
  if (result === "replacement-underpriced") {
    throw new SendRefusedError(
      `${label}: the node holds another transaction with nonce ${t.nonce} from ${ctx.chain.from} and refused this one as a ` +
        "replacement. If it is this transfer's own earlier transaction, raise SEND_MAX_FEE_GWEI (both fees are raised by at " +
        "least 12.5%) and rerun; otherwise make sure no other send uses this wallet, then rerun."
    )
  }
  throw new SendRefusedError(
    `${label}: the node refused the transaction as underpriced (below its minimum fee or the base fee, or its pool is full). ` +
      "Raise SEND_MAX_FEE_GWEI and SEND_MAX_PRIORITY_FEE_GWEI, then rerun: the transfer keeps its nonce."
  )
}

// The transfer's nonce is used: by its own transaction (whose receipt may only
// lag behind) or by another one, which a person has to look into. Returns true
// when the transfer is to be sent anew: only with `mayForget` (--forget-unmined
// for a transaction an earlier run saved; never for one this run just
// broadcast, which a lagging node may only not show yet), once neither a
// receipt nor the wallet's logs show any of its transactions mined. With
// --skip-paid-on-chain, a transfer of the same amount to the same recipient
// that the ledger does not know (its transaction replaced from another machine,
// or paid by hand) is recorded as its payment instead.
const nonceUsed = async (ctx: SendContext, t: LedgerTransfer, label: string, mayForget: boolean): Promise<boolean> => {
  const outcome = await waitForSettle(ctx.chain, t, Math.min(ctx.settings.receiptTimeoutMs, 60000), ctx.settings.pollMs)
  if (outcome !== "pending") {
    finish(outcome, t, label, ctx)
    return false
  }
  const attempts = t.attempts || (t.txHash ? [t.txHash] : [])
  // A node can lack the receipt of a mined transaction (it dropped old
  // receipts, or lags behind): the wallet's Transfer logs settle it.
  let logs: OnchainTransfer[] | null = null
  let logError = ""
  try {
    logs = await ctx.chain.outgoingTransfers(Math.floor(Date.parse(ctx.startedAt) / 1000) - 86400)
  } catch (err) {
    logError = (err as Error).message
  }
  const own = (logs || []).find((f) => attempts.some((hash) => hash.toLowerCase() === f.txHash.toLowerCase()))
  if (own) {
    t.status = "confirmed"
    t.txHash = own.txHash
    t.blockNumber = own.blockNumber
    t.confirmedAt = new Date().toISOString()
    delete t.rawTx
    ctx.save()
    ctx.log(`${label}: its transaction ${own.txHash} is on-chain (the node had no receipt for it)`)
    return false
  }
  // A payment of the same amount to the same recipient that the ledger does
  // not know is this very transfer, signed elsewhere (a replacement from
  // another machine, a payment by hand), only if it took this transfer's
  // nonce: one under another nonce belongs to something else. One whose nonce
  // the node does not tell is never taken for it, but still stops forgetting.
  let lookalike: OnchainTransfer | undefined
  let unchecked: OnchainTransfer | undefined
  for (const f of logs || []) {
    if (f.to.toLowerCase() !== t.recipient.toLowerCase() || f.amount !== t.amount || ctx.known.has(f.txHash.toLowerCase())) {
      continue
    }
    let tx: { from: string; nonce: number } | null = null
    try {
      tx = await ctx.chain.transaction(f.txHash)
    } catch {
      tx = null
    }
    if (!tx) {
      unchecked = unchecked || f
    } else if (tx.from.toLowerCase() === ctx.chain.from.toLowerCase() && tx.nonce === t.nonce) {
      lookalike = f
      break
    }
  }
  if (lookalike && ctx.skipPaidOnChain) {
    // The operator says it is this transfer's: recorded as its payment, once.
    ctx.known.add(lookalike.txHash.toLowerCase())
    t.forgottenTxs = (t.forgottenTxs || []).concat(attempts)
    clearTransaction(t)
    t.status = "confirmed"
    t.txHash = lookalike.txHash
    t.blockNumber = lookalike.blockNumber
    t.confirmedAt = new Date().toISOString()
    t.foundOnChain = true
    ctx.save()
    ctx.log(
      `${label}: recorded as paid by ${lookalike.txHash} (block ${lookalike.blockNumber}), unknown to the ledger ` +
        `(--skip-paid-on-chain); its own ${attempts.join(", ")} can no longer be mined`
    )
    return false
  }
  const lookalikeText = lookalike
    ? `tx ${lookalike.txHash} (block ${lookalike.blockNumber}) took its nonce ${t.nonce} and pays the same recipient the ` +
      "same amount, unknown to the ledger, so it may be this transfer. Look it up on the explorer: if it is (signed " +
      "elsewhere, or paid by hand), rerun with --skip-paid-on-chain to record it as paid."
    : unchecked
    ? `tx ${unchecked.txHash} (block ${unchecked.blockNumber}) pays the same recipient the same amount, unknown to the ` +
      "ledger, and the node did not say which nonce it used, so it may be this transfer. Retry, or look it up on the explorer."
    : ""
  if (mayForget && logs) {
    if (lookalikeText) {
      ctx.save()
      throw new SendRefusedError(`${label}: not forgetting it: ${lookalikeText}`)
    }
    // The nonce is taken and neither a receipt nor the logs show any of these
    // mined, so none of them ever can be.
    ctx.log(`${label}: forgetting ${attempts.join(", ")} (nonce ${t.nonce} went to another transaction), sending it again`)
    t.forgottenTxs = (t.forgottenTxs || []).concat(attempts)
    clearTransaction(t)
    t.status = "pending"
    ctx.save()
    return true
  }
  ctx.save()
  if (lookalikeText) {
    throw new SendRefusedError(
      `${label}: the wallet's nonce ${t.nonce}, which this transfer was signed with (${attempts.join(", ")}), was used by ` +
        `another transaction, and none of its own was mined. ${lookalikeText}`
    )
  }
  throw new SendRefusedError(
    `${label}: the wallet's nonce ${t.nonce}, which this transfer was signed with (${attempts.join(", ")}), was used by ` +
      "another transaction, and none of its own was mined. Look the wallet's transaction with that nonce up on the explorer: " +
      "if it does not pay this transfer, rerun with --forget-unmined to send it again with a new nonce." +
      (logError ? ` (Its Transfer logs could not be read to check: ${logError}; --forget-unmined needs them.)` : "")
  )
}

// Signs, saves, broadcasts and waits. Returns the next free nonce.
const sendNew = async (ctx: SendContext, t: LedgerTransfer, nonce: number, label: string): Promise<number> => {
  const { chain, fees } = ctx
  const { hash, raw } = await chain.signTransfer(t.recipient, BigNumber.from(t.amount), nonce, fees)
  t.status = "signed"
  t.nonce = nonce
  t.txHash = hash
  t.rawTx = raw
  t.maxFeePerGas = fees.maxFeePerGas.toString()
  t.maxPriorityFeePerGas = fees.maxPriorityFeePerGas.toString()
  t.attempts = [hash]
  ctx.known.add(hash.toLowerCase())
  ctx.save() // before the broadcast: from here on, a rerun knows this transaction
  const result = await chain.broadcast(raw)
  if (result === "nonce-too-low") {
    // A retried broadcast whose first try was mined, or another transaction.
    // Never forgotten here: it was just broadcast, and a lagging node may only
    // not show it mined yet (--forget-unmined applies to it on a rerun).
    await nonceUsed(ctx, t, label, false)
    return nonce + 1
  }
  if (result === "replacement-underpriced" || result === "underpriced") refusedBroadcast(result, t, label, ctx)
  t.status = "sent"
  ctx.save()
  ctx.log(`${label}: sent ${hash} (nonce ${nonce}), waiting for its receipt`)
  finish(await waitForSettle(chain, t, ctx.settings.receiptTimeoutMs, ctx.settings.pollMs), t, label, ctx)
  return nonce + 1
}

// Pools take a replacement only when both fees rise by 10% or more: the
// configured fee, or 12.5% above the previous one when that is higher.
const bumped = (configured: BigNumber, previous: BigNumber): BigNumber => {
  const minimum = previous.mul(1125).div(1000)
  return configured.gt(minimum) ? configured : minimum
}

// A transfer whose transaction an earlier run signed and saved: wait for it,
// rebroadcast it (or a same-nonce replacement when the fees were raised),
// never a new nonce, since the saved one may still be mined. True when it was
// forgotten (--forget-unmined) and is to be sent again.
const resumeTransfer = async (ctx: SendContext, t: LedgerTransfer, label: string): Promise<boolean> => {
  const { chain, fees } = ctx
  const nonce = t.nonce as number
  if ((await chain.nonce("latest")) > nonce) return nonceUsed(ctx, t, label, ctx.forgetUnmined)
  const previousMax = BigNumber.from(t.maxFeePerGas || 0)
  const previousTip = BigNumber.from(t.maxPriorityFeePerGas || 0)
  if (fees.maxFeePerGas.gt(previousMax) || fees.maxPriorityFeePerGas.gt(previousTip)) {
    // Within SEND_MAX_FEE_GWEI: the operator's cap, and what the gas check counted.
    const minimum = bumped(previousMax, previousMax)
    if (minimum.gt(fees.maxFeePerGas)) {
      ctx.save()
      throw new SendRefusedError(
        `${label}: replacing its stuck transaction needs a fee cap of at least ${utils.formatUnits(minimum, "gwei")} gwei ` +
          `(12.5% above the ${utils.formatUnits(previousMax, "gwei")} gwei it was sent with). Raise SEND_MAX_FEE_GWEI to that, then rerun.`
      )
    }
    const maxFee = fees.maxFeePerGas
    const wantedTip = bumped(fees.maxPriorityFeePerGas, previousTip)
    const tip = wantedTip.gt(maxFee) ? maxFee : wantedTip
    const replacement = await chain.signTransfer(t.recipient, BigNumber.from(t.amount), nonce, {
      ...fees,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
    })
    t.txHash = replacement.hash
    t.rawTx = replacement.raw
    t.maxFeePerGas = maxFee.toString()
    t.maxPriorityFeePerGas = tip.toString()
    t.attempts = (t.attempts || []).concat(replacement.hash)
    ctx.known.add(replacement.hash.toLowerCase())
    ctx.save()
    ctx.log(
      `${label}: replacing it with ${replacement.hash}, same nonce ${nonce}, fees ` +
        `${utils.formatUnits(maxFee, "gwei")} / ${utils.formatUnits(tip, "gwei")} gwei`
    )
  }
  const result = await chain.broadcast(t.rawTx as string)
  // The nonce was free a moment ago: the likeliest taker is this very
  // broadcast, which a lagging node may not show yet. Never forgotten here;
  // a rerun finds the nonce used before broadcasting, where --forget-unmined
  // applies.
  if (result === "nonce-too-low") return nonceUsed(ctx, t, label, false)
  if (result === "replacement-underpriced" || result === "underpriced") refusedBroadcast(result, t, label, ctx)
  t.status = "sent"
  ctx.save()
  ctx.log(`${label}: waiting for ${t.txHash} (nonce ${nonce}, saved by an earlier run)`)
  finish(await waitForSettle(chain, t, ctx.settings.receiptTimeoutMs, ctx.settings.pollMs), t, label, ctx)
  return false
}

// `--mode disbursements`: what the ledger holds.
export const listDisbursementsRoutine = (log: (line: string) => void = (line) => console.log(line)): DisbursementRecord[] => {
  const records = listDisbursements()
  if (records.length === 0) {
    log(`No disbursement recorded in ${displayPath(disbursementsDir())}.`)
    return records
  }
  for (const r of records) {
    const confirmed = r.transfers.filter((t) => t.status === "confirmed").length
    log(
      [
        periodLabel(r.periodStart, r.periodEnd).padEnd(9),
        r.kind.padEnd(11),
        r.status.padEnd(11),
        `${confirmed}/${r.transfers.length}`.padStart(7),
        pnk(r.total).padStart(18),
        (r.completedAt || r.createdAt).slice(0, 10),
        r.file,
        displayPath(recordPath(r)),
      ].join("  ")
    )
  }
  return records
}
