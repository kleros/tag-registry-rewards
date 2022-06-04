import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"
import { sendAllRewards } from "./transaction-sender"
import { Period, Reward } from "./types"
import conf from "./config"
import yargs = require("yargs")
import { hideBin } from "yargs/helpers"
import buildCsv from "./csv"
import { readFileSync } from "fs"

const getExpectedPeriod = (): Period => {
  const now = new Date()
  const timezone = now.getTimezoneOffset() / 60
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, -timezone)
  const end = new Date(now.getFullYear(), now.getMonth(), 1, -timezone)
  return { start, end }
}

// @types/yargs is hard to understand, skip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const argv: any = yargs(hideBin(process.argv))
  .locale("en")
  .usage(
    `Usage:
    Make CSV file:
      $0 --mode csv --start <start-date> --end <end-date> --stipend <stipend-amount>
    Send rewards:
      $0 --mode send --start <start-date> --end <end-date> --stipend <stipend-amount>`
  )
  .option("m", {
    description:
      "The mode of the execution. 'csv' will just create a csv file, 'send' will distribute rewards.",
    alias: "mode",
  })
  .option("n", {
    description: "Whether it's running on production or development",
    alias: "node",
    default: "development",
  })
  .option("a", {
    description: "The stipend of the distribution for this period",
    alias: "stipend",
    default: conf.STIPEND,
  })
  .option("s", {
    description: "The day the period starts",
    alias: "start",
  })
  .option("e", {
    description: "The day the period ends",
    alias: "end",
  })
  .option("h", {
    alias: "help",
  })
  .option("f", {
    description: "The name of the optional file",
    alias: "file",
  }).argv

const parseDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map((n) => Number(n))
  const date = new Date(Date.UTC(y, m - 1, d))
  return date
}

const main = async () => {
  const start = argv.start ? parseDate(argv.start) : getExpectedPeriod().start
  const end = argv.end ? parseDate(argv.end) : getExpectedPeriod().end
  const stipend = BigNumber.from(argv.stipend ? argv.stipend : conf.STIPEND)
  const newTagRatio = Number(
    argv["new-tag-ratio"] ? argv["new-tag-ratio"] : conf.NEW_TAG_RATIO
  )
  const nodeEnv = argv.node as string
  const mode = argv.mode as string | undefined
  if (mode === undefined) {
    throw new Error("You must choose a mode, 'csv' | 'send'")
  }
  const file = argv.file as string | undefined

  let rewards: Reward[]
  if (file) {
    const fileContent = readFileSync(`./${conf.FILES_DIR}/${file}`).toString()
    rewards = JSON.parse(fileContent)
    // rewrap the amounts onto BigNumber to recover their methods.
    rewards.forEach((reward) => {
      reward.amount = BigNumber.from(reward.amount)
    })
  } else {
    rewards = await buildRewards({ start, end }, stipend, newTagRatio)
  }

  if (mode === "csv") {
    await buildCsv(rewards)
  } else if (mode === "send") {
    await sendAllRewards(rewards, stipend, nodeEnv)
  } else {
    throw new Error(`Unrecognized mode ${mode}`)
  }
}

main()
