import { GenerateManifest, Reward, RewardRecord, Transaction } from "./types"

import { createObjectCsvWriter } from "csv-writer"
import { writeFileSync } from "fs"
import { humanizeAmount } from "./transaction-sender"
import conf from "./config"
import { ensureFilesDir, formatRegistry } from "./utils/output-helpers"

const PRETTY_CHAIN_NAME: { [chainId: string]: string } = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "1": "Ethereum Mainnet",
  "56": "Binance Smart Chain",
  "100": "Gnosis Chain",
  "137": "Polygon",
  "42161": "Arbitrum",
  "10": "Optimism",
  "324": "zkSync",
  "43114": "Avalanche",
  "42220": "Celo",
  "8453": "Base",
  "250": "Fantom",
  "534352": "Scroll",
  "59144": "Linea",
  "4326": "MegaETH Mainnet",
}

const rewardsHeader = [
  { id: "submitter", title: "Submitter" },
  { id: "registry", title: "Registry" },
  { id: "chain", title: "Chain" },
  { id: "tagAddress", title: "Address tagged" },
  { id: "latestRequestResolutionTime", title: "Registered at" },
  { id: "txCount", title: "Tx count" },
  { id: "amount", title: "Reward amount" },
]

const transactionsHeader = [
  { id: "recipient", title: "Recipient" },
  { id: "amount", title: "Amount" },
]

const generateTransactions = (rewards: Reward[]): Transaction[] => {
  const transactionMap: { [address: string]: Transaction } = {}
  for (const reward of rewards) {
    if (!transactionMap[reward.recipient]) {
      transactionMap[reward.recipient] = {
        amount: reward.amount,
        recipient: reward.recipient,
      }
    } else {
      transactionMap[reward.recipient].amount = transactionMap[
        reward.recipient
      ].amount.add(reward.amount)
    }
  }
  return Object.values(transactionMap)
}

const buildCsv = async (rewards: Reward[]): Promise<void> => {
  console.info("=== Building csv file ===")
  const filename = new Date().getTime()
  ensureFilesDir()
  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${filename}.csv`,
    header: rewardsHeader,
  })
  const rows = rewards.map((reward) => {
    const { submitter, txCount, latestRequestResolutionTime, tagAddress } =
      reward.contractInfo

    const humanAmount = humanizeAmount(reward.amount)

    const prettierChainName = PRETTY_CHAIN_NAME[reward.contractInfo.chain]

    return {
      submitter,
      txCount,
      latestRequestResolutionTime: new Date(
        latestRequestResolutionTime * 1000
      ).toISOString(),
      tagAddress,
      registry: formatRegistry(reward.contractInfo.registry),
      chain: prettierChainName,
      amount: humanAmount,
    }
  })

  await csvWriter.writeRecords(rows)
  // also store the transactions to be made as a json
  const transactions = generateTransactions(rewards)

  const transactionsJson = JSON.stringify(transactions)
  writeFileSync(`./${conf.FILES_DIR}/${filename}.json`, transactionsJson, {
    encoding: "utf-8",
  })

  // now, generate a csv with the final transactions that will be sent
  const csvWriterTx = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${filename}_tx.csv`,
    header: transactionsHeader,
  })

  const rowsTx = transactions.map((tx) => {
    const { amount, recipient } = tx
    const humanAmount = humanizeAmount(amount)
    return {
      recipient,
      amount: humanAmount,
    }
  })

  await csvWriterTx.writeRecords(rowsTx)

  // Persist breakdown-rich reward records + a manifest so the `document` step
  // can merge submissions with removals for the same period.
  const rewardRecords: RewardRecord[] = rewards.map((reward) => ({
    recipient: reward.recipient,
    id: reward.id,
    registry: reward.contractInfo.registry,
    chain: reward.contractInfo.chain,
    chainName:
      PRETTY_CHAIN_NAME[reward.contractInfo.chain] || reward.contractInfo.chain,
    tagAddress: reward.contractInfo.tagAddress,
    amount: reward.amount.toString(),
  }))
  const rewardsFile = `${filename}_rewards.json`
  writeFileSync(
    `./${conf.FILES_DIR}/${rewardsFile}`,
    JSON.stringify(rewardRecords, null, 2),
    { encoding: "utf-8" }
  )

  const manifest: GenerateManifest = {
    runId: String(filename),
    generatedAt: new Date().toISOString(),
    rewardsFile,
    transactionsFile: `${filename}.json`,
  }
  writeFileSync(
    `./${conf.FILES_DIR}/latest_generate_manifest.json`,
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8" }
  )
}

export default buildCsv
