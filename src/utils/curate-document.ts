import { BigNumber } from "ethers"
import { existsSync, readFileSync, writeFileSync } from "fs"
import conf from "../config"
import {
  AtqRewardRecord,
  CurateIndexEntry,
  CurateRecipient,
  CurateRewardLine,
  CurateSnapshot,
  Period,
  RewardRecord,
} from "../types"
import { ensureFilesDir } from "./output-helpers"

const INDEX_FILE = "curate-rewards-index.json"

const emptyRecipient = (): CurateRecipient => ({
  total: "0",
  submissions: [],
  removals: [],
  atq: [],
})

// Merge submission, removal, and ATQ reward records into one per-recipient
// snapshot (the record a user looks up on the page).
export const buildCurateSnapshot = (
  periodLabel: string,
  period: Period,
  submissions: RewardRecord[],
  removals: RewardRecord[],
  atq: AtqRewardRecord[]
): CurateSnapshot => {
  const recipients: { [address: string]: CurateRecipient } = {}
  let submissionsTotal = BigNumber.from(0)
  let removalsTotal = BigNumber.from(0)
  let atqTotal = BigNumber.from(0)

  const add = (
    recipient: string,
    kind: "submissions" | "removals" | "atq",
    line: CurateRewardLine
  ): void => {
    const key = recipient.toLowerCase()
    if (!recipients[key]) recipients[key] = emptyRecipient()
    recipients[key][kind].push(line)
    recipients[key].total = BigNumber.from(recipients[key].total)
      .add(BigNumber.from(line.amount))
      .toString()
  }

  const lineOf = (record: RewardRecord): CurateRewardLine => ({
    registry: record.registry,
    chain: record.chain,
    chainName: record.chainName,
    tagAddress: record.tagAddress,
    amount: record.amount,
  })

  for (const record of submissions) {
    add(record.recipient, "submissions", lineOf(record))
    submissionsTotal = submissionsTotal.add(BigNumber.from(record.amount))
  }
  for (const record of removals) {
    add(record.recipient, "removals", lineOf(record))
    removalsTotal = removalsTotal.add(BigNumber.from(record.amount))
  }
  for (const record of atq) {
    add(record.recipient, "atq", {
      registry: "atq",
      chain: "",
      chainName: record.kind, // "registered" | "removed"
      tagAddress: record.itemID,
      amount: record.amount,
    })
    atqTotal = atqTotal.add(BigNumber.from(record.amount))
  }

  return {
    schema: "curate-rewards/v1",
    period: {
      label: periodLabel,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    generatedAt: new Date().toISOString(),
    chainId: Number(conf.TX_NETWORK_ID),
    token: { symbol: "PNK", address: conf.PNK },
    totals: {
      submissions: submissionsTotal.toString(),
      removals: removalsTotal.toString(),
      atq: atqTotal.toString(),
      total: submissionsTotal.add(removalsTotal).add(atqTotal).toString(),
      recipientCount: Object.keys(recipients).length,
    },
    recipients,
  }
}

export const writeCurateSnapshot = (
  snapshot: CurateSnapshot
): { file: string; path: string } => {
  ensureFilesDir()
  const file = `curate-rewards-${snapshot.period.label}.json`
  const path = `./${conf.FILES_DIR}/${file}`
  writeFileSync(path, JSON.stringify(snapshot, null, 2), { encoding: "utf-8" })
  return { file, path }
}

// Upsert the period entry into the local index the page enumerates. Newest first.
export const updateCurateIndex = (entry: CurateIndexEntry): CurateIndexEntry[] => {
  ensureFilesDir()
  const path = `./${conf.FILES_DIR}/${INDEX_FILE}`
  let index: CurateIndexEntry[] = []
  if (existsSync(path)) {
    try {
      index = JSON.parse(readFileSync(path).toString()) as CurateIndexEntry[]
    } catch {
      index = []
    }
  }
  index = index.filter((e) => e.period !== entry.period)
  index.push(entry)
  index.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))
  writeFileSync(path, JSON.stringify(index, null, 2), { encoding: "utf-8" })
  return index
}
