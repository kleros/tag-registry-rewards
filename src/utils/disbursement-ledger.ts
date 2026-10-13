import { createHash } from "crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "fs"
import { join, relative, resolve } from "path"
import { acquireLockFile } from "./lock-file"

// The record of every disbursement (`--mode send`): one JSON file per
// transactions file paid, in DISBURSEMENTS_DIR (default ./disbursements).
// Commit it like exclusions.json: it is the audit trail of what was paid, and
// a machine that has it refuses to pay the same file again.
//
// `send` writes each transfer's signed transaction here before broadcasting
// it, and binds the transfer to that nonce: a rerun after a crash at any point
// finds the transaction and waits for it (or rebroadcasts the very same one),
// so no transfer can be paid twice.

export type DisbursementKind = "submissions" | "removals" | "atq" | "unknown"

// pending: nothing signed yet. signed: a transaction is signed and saved, maybe
// broadcast. sent: a node accepted it. confirmed: mined with status 1.
// failed: its transaction reverted (nothing was paid by it); a rerun signs a new one.
export type TransferStatus = "pending" | "signed" | "sent" | "confirmed" | "failed"

export interface LedgerTransfer {
  recipient: string
  amount: string // wei
  status: TransferStatus
  nonce?: number
  txHash?: string // the latest transaction signed for it
  rawTx?: string // that transaction, signed: rebroadcasting it cannot pay twice
  maxFeePerGas?: string
  attempts?: string[] // every transaction signed for it, all with `nonce`
  maxPriorityFeePerGas?: string
  revertedTxs?: string[] // mined but reverted: nothing was paid by them
  forgottenTxs?: string[] // never mined, their nonce taken by another transaction (--forget-unmined)
  blockNumber?: number
  confirmedAt?: string
  foundOnChain?: boolean // paid before this ledger knew of it (found on-chain)
}

export interface DisbursementRecord {
  version: 1
  id: string // the payout: its content, kind and period
  contentId: string // what is paid: chain, token and the (recipient, amount) list
  file: string
  fileSha256: string
  kind: DisbursementKind
  periodStart?: string
  periodEnd?: string
  chainId: number
  token: string
  from: string
  status: "in-progress" | "completed"
  total: string // wei
  createdAt: string
  updatedAt: string
  completedAt?: string
  transfers: LedgerTransfer[]
}

export const disbursementsDir = (): string =>
  resolve(String(process.env.DISBURSEMENTS_DIR || "").trim() || "disbursements")

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

export const fileSha256 = (path: string): string => sha256(readFileSync(path))

// What a payout pays, whatever the file's name, formatting or order: the
// chain, the token and the (recipient, amount) list.
export const contentId = (
  chainId: number,
  token: string,
  transfers: { recipient: string; amount: string }[]
): string => {
  // By code unit, as Array.prototype.sort does by default: never by locale,
  // which could order them otherwise on another machine and change the id.
  const pairs = transfers
    .map((t) => `${t.recipient.toLowerCase()}:${t.amount}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(JSON.stringify({ chainId, token: token.toLowerCase(), transfers: pairs }))
}

// A payout: its content for a kind and period. Capped removal and ATQ rewards
// make identical files recur (the same remover, 7,000 PNK, two months in a
// row; one address owed 500 PNK as remover and as ATQ requester), and those
// are different payouts.
export const disbursementId = (content: string, kind: DisbursementKind, periodStart?: string, periodEnd?: string): string =>
  sha256(JSON.stringify({ content, kind, periodStart: periodStart || null, periodEnd: periodEnd || null }))

// "2026-09" for a calendar month, else the dates; "unknown" without a period.
export const periodLabel = (start?: string, end?: string): string => {
  if (!start || !end) return "unknown"
  const s = new Date(start)
  const e = new Date(end)
  const monthStart = (d: Date) =>
    d.getUTCDate() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
  const nextMonth = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1))
  if (monthStart(s) && e.getTime() === nextMonth.getTime()) {
    return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`
  }
  return `${start.slice(0, 10)}_${end.slice(0, 10)}`
}

export const recordFileName = (record: DisbursementRecord): string =>
  `${periodLabel(record.periodStart, record.periodEnd)}-${record.kind}-${record.id.slice(0, 12)}.json`

export const recordPath = (record: DisbursementRecord): string => join(disbursementsDir(), recordFileName(record))

// For messages: the path from the working directory.
export const displayPath = (path: string): string => relative(process.cwd(), path) || path

// Every record, oldest first. A record that cannot be read stops the run: a
// ledger silently skipped could let a paid file be paid again.
export const listDisbursements = (): DisbursementRecord[] => {
  const dir = disbursementsDir()
  if (!existsSync(dir)) return []
  const records: DisbursementRecord[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue
    const path = join(dir, name)
    let record: DisbursementRecord
    try {
      record = JSON.parse(readFileSync(path).toString()) as DisbursementRecord
    } catch (err) {
      throw new Error(`[disbursements] ${path} is not valid JSON (${err}). Restore it from git before sending.`)
    }
    if (!record || record.version !== 1 || !record.id || !Array.isArray(record.transfers)) {
      throw new Error(`[disbursements] ${path} is not a disbursement record. Restore it from git before sending.`)
    }
    records.push(record)
  }
  return records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}

// Written to a temporary file, flushed to disk and renamed (the directory
// flushed too): a crash leaves the previous version or the new one, never a
// torn file. A transaction is only broadcast after the record holding it is saved.
export const saveDisbursement = (record: DisbursementRecord): string => {
  const dir = disbursementsDir()
  mkdirSync(dir, { recursive: true })
  record.updatedAt = new Date().toISOString()
  const path = recordPath(record)
  const tmp = `${path}.${process.pid}.tmp`
  const fd = openSync(tmp, "w")
  try {
    writeSync(fd, JSON.stringify(record, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  try {
    const dirFd = openSync(dir, "r")
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // directories cannot be opened or flushed on every platform (Windows)
  }
  return path
}

// One send at a time per ledger (see acquireLockFile).
export const acquireDisbursementLock = (): (() => void) => acquireLockFile(disbursementsDir(), "disbursements")
