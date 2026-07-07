import { createObjectCsvWriter } from "csv-writer"
import { writeFileSync } from "fs"
import { BigNumber } from "ethers"
import conf from "../config"
import {
  AtqReward,
  AtqRewardRecord,
  AtqRow,
  Period,
  RemovalReward,
  RemovalsManifest,
  RewardRecord,
  Transaction,
} from "../types"
import { humanizeAmount } from "../transaction-sender"
import { ensureFilesDir, formatRegistry } from "./output-helpers"

const toIso = (unixSeconds: number): string =>
  unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : ""

// Aggregate any {recipient, amount} rewards per recipient into the shape `send`
// consumes.
const aggregateTransactions = (
  rewards: Array<{ recipient: string; amount: BigNumber }>
): Transaction[] => {
  const map: { [recipient: string]: Transaction } = {}
  for (const reward of rewards) {
    if (!map[reward.recipient]) {
      map[reward.recipient] = {
        recipient: reward.recipient,
        amount: reward.amount,
      }
    } else {
      map[reward.recipient].amount = map[reward.recipient].amount.add(
        reward.amount
      )
    }
  }
  return Object.values(map)
}

const writeTransactionsCsv = async (
  path: string,
  transactions: Transaction[]
): Promise<void> => {
  const csvWriter = createObjectCsvWriter({
    path,
    header: [
      { id: "recipient", title: "Recipient" },
      { id: "amount", title: "Amount" },
    ],
  })
  await csvWriter.writeRecords(
    transactions.map((tx) => ({
      recipient: tx.recipient,
      amount: humanizeAmount(tx.amount),
    }))
  )
}

// ATQ report CSV, now with the per-event reward amount filled in.
const writeAtqCsv = async (
  path: string,
  kind: "registered" | "removed",
  rows: AtqRow[],
  amountByKey: Map<string, BigNumber>
): Promise<void> => {
  const csvWriter = createObjectCsvWriter({
    path,
    header: [
      { id: "itemID", title: "Item ID" },
      { id: "submissionTime", title: "Submission Time" },
      { id: "resolutionTime", title: `Resolution Time (${kind})` },
      { id: "requester", title: "Requester" },
      { id: "metadata", title: "Metadata" },
      { id: "rewarded", title: "Rewarded" },
    ],
  })
  await csvWriter.writeRecords(
    rows.map((row) => {
      const amount = amountByKey.get(`${row.itemID}:${kind}`)
      return {
        itemID: row.itemID,
        submissionTime: toIso(row.submissionTime),
        resolutionTime: toIso(row.resolutionTime),
        requester: row.requester,
        metadata: row.metadata,
        rewarded: amount ? humanizeAmount(amount) : "",
      }
    })
  )
}

export const writeRemovalsOutputs = async (
  runId: string,
  period: Period,
  rewards: RemovalReward[],
  atqRegistered: AtqRow[],
  atqAbsent: AtqRow[],
  atqRewards: AtqReward[]
): Promise<RemovalsManifest> => {
  ensureFilesDir()

  const removalsCsvFile = `${runId}_removals.csv`
  const removalsJsonFile = `${runId}_removals.json`
  const transactionsFile = `${runId}_removals_transactions.json`
  const transactionsCsvFile = `${runId}_removals_transactions.csv`
  const atqRegisteredCsvFile = `${runId}_atq_registered.csv`
  const atqAbsentCsvFile = `${runId}_atq_absent.csv`
  const atqRewardsJsonFile = `${runId}_atq.json`
  const atqTransactionsFile = `${runId}_atq_transactions.json`
  const atqTransactionsCsvFile = `${runId}_atq_transactions.csv`

  // Detail CSV, one row per rewarded removal.
  const detailWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${removalsCsvFile}`,
    header: [
      { id: "submitter", title: "Submitter" },
      { id: "registry", title: "Registry" },
      { id: "chain", title: "Chain" },
      { id: "tagAddress", title: "Address tagged" },
      { id: "removedAt", title: "Removed at" },
      { id: "amount", title: "Reward amount" },
    ],
  })
  await detailWriter.writeRecords(
    rewards.map((reward) => ({
      submitter: reward.removal.submitter,
      registry: formatRegistry(reward.removal.registry),
      chain: reward.removal.chainName || reward.removal.chain,
      tagAddress: reward.removal.tagAddress,
      removedAt: toIso(reward.removal.removedAt),
      amount: humanizeAmount(reward.amount),
    }))
  )

  const removalRecords: RewardRecord[] = rewards.map((reward) => ({
    recipient: reward.recipient,
    id: reward.id,
    registry: reward.removal.registry,
    chain: reward.removal.chain,
    chainName: reward.removal.chainName || reward.removal.chain,
    tagAddress: reward.removal.tagAddress,
    amount: reward.amount.toString(),
  }))
  writeFileSync(
    `./${conf.FILES_DIR}/${removalsJsonFile}`,
    JSON.stringify(removalRecords, null, 2),
    { encoding: "utf-8" }
  )

  // Send-compatible removal transactions (aggregated per recipient).
  const transactions = aggregateTransactions(rewards)
  writeFileSync(
    `./${conf.FILES_DIR}/${transactionsFile}`,
    JSON.stringify(transactions),
    { encoding: "utf-8" }
  )
  await writeTransactionsCsv(
    `./${conf.FILES_DIR}/${transactionsCsvFile}`,
    transactions
  )

  // ATQ rewards: JSON for the document step, its own send-compatible tx file, and
  // the amounts filled into the report CSVs.
  const atqAmountByKey = new Map<string, BigNumber>()
  for (const reward of atqRewards) atqAmountByKey.set(reward.id, reward.amount)

  const atqRewardRecords: AtqRewardRecord[] = atqRewards.map((reward) => ({
    recipient: reward.recipient,
    id: reward.id,
    kind: reward.kind,
    itemID: reward.itemID,
    metadata: reward.metadata,
    amount: reward.amount.toString(),
  }))
  writeFileSync(
    `./${conf.FILES_DIR}/${atqRewardsJsonFile}`,
    JSON.stringify(atqRewardRecords, null, 2),
    { encoding: "utf-8" }
  )

  const atqTransactions = aggregateTransactions(atqRewards)
  writeFileSync(
    `./${conf.FILES_DIR}/${atqTransactionsFile}`,
    JSON.stringify(atqTransactions),
    { encoding: "utf-8" }
  )
  await writeTransactionsCsv(
    `./${conf.FILES_DIR}/${atqTransactionsCsvFile}`,
    atqTransactions
  )

  await writeAtqCsv(
    `./${conf.FILES_DIR}/${atqRegisteredCsvFile}`,
    "registered",
    atqRegistered,
    atqAmountByKey
  )
  await writeAtqCsv(
    `./${conf.FILES_DIR}/${atqAbsentCsvFile}`,
    "removed",
    atqAbsent,
    atqAmountByKey
  )

  const sumOf = (txs: Transaction[]): BigNumber =>
    txs.reduce((acc, tx) => acc.add(tx.amount), BigNumber.from(0))
  console.log("Total removal PNK:", sumOf(transactions).toString())
  console.log("Total ATQ PNK:", sumOf(atqTransactions).toString())

  const manifest: RemovalsManifest = {
    runId,
    generatedAt: new Date().toISOString(),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    removalsCsvFile,
    removalsJsonFile,
    transactionsFile,
    transactionsCsvFile,
    atqRegisteredCsvFile,
    atqAbsentCsvFile,
    atqRewardsJsonFile,
    atqTransactionsFile,
    atqTransactionsCsvFile,
    removalCount: rewards.length,
    atqRegisteredCount: atqRegistered.length,
    atqAbsentCount: atqAbsent.length,
    atqRewardCount: atqRewards.length,
  }
  const manifestFile = `${runId}_removals_manifest.json`
  writeFileSync(
    `./${conf.FILES_DIR}/${manifestFile}`,
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8" }
  )
  writeFileSync(
    `./${conf.FILES_DIR}/latest_removals_manifest.json`,
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8" }
  )

  return manifest
}
