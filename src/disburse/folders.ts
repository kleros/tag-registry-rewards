import { BigNumber } from "ethers"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join, relative, resolve, sep } from "path"
import conf from "../config"
import { readTransactionsFile, resolveSource, SendRefusedError } from "../send-routine"
import { GenerateManifest, RemovalsManifest } from "../types"
import {
  contentId,
  disbursementId,
  DisbursementKind,
  DisbursementRecord,
  listDisbursements,
  periodLabel,
} from "../utils/disbursement-ledger"
import { sendChainId, sendTokenAddress } from "../utils/send-chain"

// The folders of files/ the disburse page can pay from: FILES_DIR itself and
// its subfolders (three levels down) holding the manifests generate and
// removals write, each with its payouts, the transactions files those
// manifests name. Read from disk only, no chain.

export const PAYOUT_KINDS: DisbursementKind[] = ["submissions", "removals", "atq"]

export interface FolderPayout {
  kind: DisbursementKind
  file: string // the transactions file, in the folder
  period: string // "2026-10", or "unknown"
  transfers: number
  total: string // wei
  // Ledger state of this payout (its content, kind and period).
  status: "not paid" | "in progress" | "disbursed"
  // Why it cannot be paid from here, read from the file itself.
  problem?: string
}

export interface PayoutFolder {
  id: string // the folder, relative to FILES_DIR ("." for FILES_DIR itself)
  payouts: FolderPayout[]
}

const MAX_DEPTH = 3

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path).toString()) as T
  } catch {
    return null
  }
}

// The transactions file of each kind the folder's latest manifests name.
const payoutFiles = (dir: string): { kind: DisbursementKind; file: string }[] => {
  const out: { kind: DisbursementKind; file: string }[] = []
  const generate = readJson<GenerateManifest>(join(dir, "latest_generate_manifest.json"))
  if (generate && generate.transactionsFile) out.push({ kind: "submissions", file: generate.transactionsFile })
  const removals = readJson<RemovalsManifest>(join(dir, "latest_removals_manifest.json"))
  if (removals && removals.transactionsFile) out.push({ kind: "removals", file: removals.transactionsFile })
  if (removals && removals.atqTransactionsFile) out.push({ kind: "atq", file: removals.atqTransactionsFile })
  return out
}

// The folder's payouts, with their ledger state (`records`: the ledger, read
// once by the caller; an unreadable ledger is the caller's error to report).
export const folderPayouts = (dir: string, records?: DisbursementRecord[]): FolderPayout[] => {
  let chainId: number | null = null
  let token: string | null = null
  try {
    chainId = sendChainId()
    token = sendTokenAddress()
  } catch {
    // reported per payout below
  }
  const ledger = chainId === null || token === null ? [] : records || listDisbursements()
  const files = payoutFiles(dir)
  return files.map(({ kind, file }, i) => {
    const source = resolveSource(file, dir)
    const period = periodLabel(source.periodStart, source.periodEnd)
    const base = { kind, file, period, transfers: 0, total: "0", status: "not paid" as FolderPayout["status"] }
    // One file is one payout: named for two kinds (a manifest edited by hand),
    // paying both would pay it twice.
    const twin = files.slice(0, i).find((f) => f.file === file)
    if (twin) return { ...base, problem: `the manifests name ${file} for ${twin.kind} too: one file is one payout` }
    if (!existsSync(join(dir, file))) return { ...base, problem: `${file} is missing from the folder` }
    let transfers: { recipient: string; amount: BigNumber }[]
    try {
      transfers = readTransactionsFile(join(dir, file)).transfers
    } catch (err) {
      return { ...base, problem: err instanceof SendRefusedError ? err.message : String(err) }
    }
    const total = transfers.reduce((sum, t) => sum.add(t.amount), BigNumber.from(0)).toString()
    if (chainId === null || token === null) return { ...base, transfers: transfers.length, total, problem: "TX_NETWORK_ID or PNK is not set" }
    const planned = transfers.map((t) => ({ recipient: t.recipient, amount: t.amount.toString() }))
    const content = contentId(chainId, token, planned)
    // as send identifies it: the kind and period its manifest gives
    const id = disbursementId(content, source.kind, source.periodStart, source.periodEnd)
    const mine = ledger.filter((r) => r.id === id)
    const status = mine.some((r) => r.status === "completed") ? "disbursed" : mine.length > 0 ? "in progress" : "not paid"
    return { ...base, transfers: transfers.length, total, status }
  })
}

// Every folder under FILES_DIR (itself included) whose manifests name a
// transactions file, as paths relative to it, sorted.
export const listPayoutFolders = (root: string = conf.FILES_DIR): PayoutFolder[] => {
  const base = resolve(root)
  const out: PayoutFolder[] = []
  // Read once, outside the folders' own errors: an unreadable ledger stops the
  // listing with its own message rather than hiding every folder.
  let records: DisbursementRecord[] = []
  try {
    sendChainId()
    sendTokenAddress()
    records = listDisbursements()
  } catch (err) {
    if (/\[disbursements\]/.test(String(err && (err as Error).message))) throw err
  }
  const visit = (dir: string, depth: number): void => {
    let payouts: FolderPayout[] = []
    try {
      payouts = folderPayouts(dir, records)
    } catch {
      payouts = []
    }
    if (payouts.length > 0) out.push({ id: relative(base, dir).split(sep).join("/") || ".", payouts })
    if (depth >= MAX_DEPTH) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue
      const path = join(dir, name)
      try {
        if (statSync(path).isDirectory()) visit(path, depth + 1)
      } catch {
        // gone in the meantime
      }
    }
  }
  if (existsSync(base)) visit(base, 0)
  return out
}

// The absolute path of one of those folders, given its id: only a folder the
// listing returns, never a path the page made up.
export const resolvePayoutFolder = (id: string, root: string = conf.FILES_DIR): string => {
  const folder = listPayoutFolders(root).find((f) => f.id === id)
  if (!folder) throw new SendRefusedError(`"${id}" is not a folder of ${root}/ with payouts to disburse`)
  const path = resolve(root, folder.id)
  const inside = relative(resolve(root), path)
  if (inside.startsWith(`..${sep}`) || inside === "..") throw new SendRefusedError(`"${id}" is outside ${root}/`)
  return path
}
