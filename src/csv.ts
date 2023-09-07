import { Reward, Transaction } from "./types"

import { createObjectCsvWriter } from "csv-writer"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { humanizeAmount } from "./transaction-sender"
import conf from "./config"

const rewardsHeader = [
  { id: "submitter", title: "Submitter" },
  { id: "registry", title: "Registry" },
  { id: "chain", title: "Chain" },
  { id: "tagAddress", title: "Address tagged" },
  { id: "latestRequestResolutionTime", title: "Registered at" },
  { id: "gasUsed", title: "Gas spent" },
  { id: "weight", title: "Weight" },
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
  if (!existsSync(`./${conf.FILES_DIR}`)) {
    mkdirSync(`./${conf.FILES_DIR}`)
  }
  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${filename}.csv`,
    header: rewardsHeader,
  })
  const rows = rewards.map((reward) => {
    const { submitter, gasUsed, latestRequestResolutionTime, tagAddress } =
      reward.contractInfo

    const humanAmount = humanizeAmount(reward.amount)
    const prettierWeight = (reward.weight * 100).toFixed(3) + "%"

    const prettierRegistryName = {
      addressTags: "Address Tags",
      tokens: "Kleros Tokens",
      domains: "Domains", // todo?
    }[reward.contractInfo.registry]

    const prettierChainName = {
      "1": "Ethereum Mainnet",
      "56": "Binance Smart Chain",
      "100": "Gnosis Chain",
      "137": "Polygon",
    }[reward.contractInfo.chain]

    return {
      submitter,
      gasUsed,
      latestRequestResolutionTime: new Date(
        latestRequestResolutionTime * 1000
      ).toISOString(),
      tagAddress: tagAddress,
      registry: prettierRegistryName,
      chain: prettierChainName,
      weight: prettierWeight,
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
}

export default buildCsv
