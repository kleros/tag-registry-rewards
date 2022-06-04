import { Reward } from "./types"

import { createObjectCsvWriter } from "csv-writer"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { humanizeAmount } from "./transaction-sender"
import conf from "./config"

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
  if (!existsSync(`./${conf.FILES_DIR}`)) {
    mkdirSync(`./${conf.FILES_DIR}`)
  }
  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${filename}.csv`,
    header,
  })
  const rows = rewards.map((reward) => {
    const { submitter, gasUsed, latestRequestResolutionTime, tagAddress } =
      reward.contractInfo
    const humanAmount = humanizeAmount(reward.amount)
    return {
      submitter,
      gasUsed,
      latestRequestResolutionTime: new Date(
        latestRequestResolutionTime * 1000
      ).toISOString(),
      tagAddress,
      amount: humanAmount,
    }
  })
  await csvWriter.writeRecords(rows)
  // also store the rewards as a json
  const rewardsJson = JSON.stringify(rewards)
  writeFileSync(`./${conf.FILES_DIR}/${filename}.json`, rewardsJson, {
    encoding: "utf-8",
  })
}

export default buildCsv
