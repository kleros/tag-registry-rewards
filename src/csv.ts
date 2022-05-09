import { Reward } from "./types"

import { createObjectCsvWriter } from "csv-writer"
import { existsSync, mkdirSync } from "fs"
import { humanizeAmount } from "./transaction-sender"

const header = [
  { id: "submitter", title: "Submitter" },
  { id: "tagAddress", title: "Address tagged" },
  { id: "latestRequestResolutionTime", title: "Registered at" },
  { id: "gasUsed", title: "Gas spent" },
  { id: "amount", title: "Reward amount" },
]

const buildCsv = async (rewards: Reward[]): Promise<void> => {
  console.info("=== Building csv file ===")
  const filename = new Date().getTime()
  if (!existsSync("./csv")) {
    mkdirSync("./csv")
  }
  const csvWriter = createObjectCsvWriter({
    path: `./csv/${filename}.csv`,
    header,
  })
  const rows = rewards.map((reward) => {
    const { submitter, gasUsed, latestRequestResolutionTime, tagAddress } =
      reward.contractInfo
    const humanAmount = humanizeAmount(reward.amount)
    return {
      submitter,
      gasUsed,
      latestRequestResolutionTime: new Date(latestRequestResolutionTime * 1000).toISOString(),
      tagAddress,
      amount: humanAmount,
    }
  })
  await csvWriter.writeRecords(rows)
}

export default buildCsv
