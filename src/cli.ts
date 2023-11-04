import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"
import { sendAllRewards } from "./transaction-sender"
import { GasDune, Tag, Transaction } from "./types"
import conf from "./config"
import yargs = require("yargs")
import { hideBin } from "yargs/helpers"
import buildCsv from "./csv"
import { readFileSync } from "fs"
import { tagsRoutine } from "./tags-routine"

const getExpectedDates = (): { start: Date; end: Date; editStart: Date } => {
  const now = new Date()
  const timezone = now.getTimezoneOffset() / 60
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, -timezone)
  const end = new Date(now.getFullYear(), now.getMonth(), 1, -timezone)
  const editStart = new Date(
    now.getFullYear(),
    now.getMonth() - 2,
    1,
    -timezone
  )
  return { start, end, editStart }
}

// @types/yargs is hard to understand, skip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const argv: any = yargs(hideBin(process.argv))
  .locale("en")
  .usage(
    `Usage:
    Fetch tags:
      $0 --mode tags --start <start-date> --end <end-date>
    Generate rewards file:
      $0 --mode rewards --tags \${filename}.json --gas \${filename}.json
    Send rewards:
      $0 --mode send --rewards \${filename}.json`
  )
  .option("m", {
    description:
      "The mode of the execution. 3 steps: 'tags', 'generate', and 'send'",
    alias: "mode",
  })
  .option("n", {
    description: "Whether it's running on production or development",
    alias: "node",
    default: "development",
  })
  .option("s", {
    description: "The day the period starts",
    alias: "start",
  })
  .option("e", {
    description: "The day the period ends",
    alias: "end",
  })
  .option("d", {
    description: "The day the edit period starts",
    alias: "edit",
  })
  .option("h", {
    alias: "help",
  })
  .option("t", {
    description: "The name of the tags file",
    alias: "tags",
  })
  .option("g", {
    description: "The name of the gas file",
    alias: "gas",
  })
  .option("r", {
    description: "The name of the rewards file",
    alias: "rewards",
  }).argv

const parseDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map((n) => Number(n))
  const date = new Date(Date.UTC(y, m - 1, d))
  return date
}

const main = async () => {
  const mode = argv.mode as string | undefined
  if (mode === undefined) {
    throw new Error("You must choose a mode, 'tags' | 'rewards' | 'send'")
  }
  if (mode === "tags") {
    // fetch the tags according to a period. first step.
    // after operator generates the tags, follow the instructions and run `rewards` next.
    let { start, end, editStart } = getExpectedDates()
    start = argv.start ? parseDate(argv.start) : start
    end = argv.end ? parseDate(argv.end) : end
    editStart = argv.edit ? parseDate(argv.edit) : editStart
    await tagsRoutine({ start, end }, { start: editStart, end })
  } else if (mode === "rewards") {
    // generate the rewards from tags and gas query
    const stipend = BigNumber.from(conf.STIPEND)
    const tagsFilename = argv.tags
    const gasFilename = argv.gas
    if (!tagsFilename || !gasFilename)
      throw new Error("JSON files for tags and gas needed")
    const tags: Tag[] = JSON.parse(
      readFileSync(`./${conf.FILES_DIR}/${tagsFilename}`).toString()
    )
    const gasDunes: GasDune[] = JSON.parse(
      readFileSync(`./${conf.FILES_DIR}/${gasFilename}`).toString()
    )
    const rewards = await buildRewards(stipend, tags, gasDunes)
    await buildCsv(rewards)
  } else if (mode === "send") {
    // disburse rewards
    const file = argv.file
    const nodeEnv = argv.node as string
    if (!file) throw new Error("JSON file needed to send the full rewards")
    const fileContent = readFileSync(`./${conf.FILES_DIR}/${file}`).toString()
    const rewards: Transaction[] = JSON.parse(fileContent)
    // rewrap the amounts onto BigNumber to recover their methods.
    rewards.forEach((reward) => {
      reward.amount = BigNumber.from(reward.amount)
    })
    await sendAllRewards(rewards, nodeEnv)
  } else {
    throw new Error(`Unrecognized mode ${mode}`)
  }
}

main()
