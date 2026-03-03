import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"
import { sendAllRewards } from "./transaction-sender"
import { FetchManifest, GasDune, Tag, Transaction } from "./types"
import conf from "./config"
import yargs = require("yargs")
import { hideBin } from "yargs/helpers"
import buildCsv from "./csv"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { tagsRoutine } from "./tags-routine"
import { filterCheckRoutine } from "./filter-check-routine"

const getExpectedDates = (): { start: Date; end: Date } => {
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
    Fetch tags:
      $0 --mode fetch --start <start-date> --end <end-date>
    Filter-check exclusions:
      $0 --mode filter-check --start <start-date> --end <end-date>
    Generate rewards file:
      $0 --mode generate --tags \${filename}.json --gas \${filename}.json
      $0 --mode generate # uses files/latest_fetch_manifest.json
    Send rewards:
      $0 --mode send --rewards \${filename}.json`
  )
  .option("m", {
    description:
      "The mode of the execution. Steps: 'fetch', 'filter-check', 'generate', and 'send'",
    alias: "mode",
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

const getLatestManifest = (): FetchManifest => {
  const filename = `./${conf.FILES_DIR}/latest_fetch_manifest.json`
  if (!existsSync(filename)) {
    throw new Error(
      "No latest fetch manifest found. Run --mode fetch or provide --tags and --gas."
    )
  }
  return JSON.parse(readFileSync(filename).toString()) as FetchManifest
}

const main = async () => {
  const mode = argv.mode as string | undefined
  if (mode === undefined) {
    throw new Error(
      "You must choose a mode, 'fetch' | 'filter-check' | 'generate' | 'send'"
    )
  }
  if (mode === "fetch") {
    // fetch the tags according to a period. first step.
    // after operator generates the tags, follow the instructions and run `generate` next.
    let { start, end } = getExpectedDates()
    start = argv.start ? parseDate(argv.start) : start
    end = argv.end ? parseDate(argv.end) : end
    console.log(`Run directory: ${process.cwd()}`)
    console.log(`Output directory: ${resolve(process.cwd(), conf.FILES_DIR)}`)
    const manifest = await tagsRoutine({ start, end })
    console.log(`Fetch CSV output: ${manifest.fullCsvFile}`)
    console.log(`Generate tags file: ${manifest.generateTagsFile}`)
    console.log(`Generate gas file: ${manifest.generateGasFile}`)
  } else if (mode === "filter-check") {
    let { start, end } = getExpectedDates()
    start = argv.start ? parseDate(argv.start) : start
    end = argv.end ? parseDate(argv.end) : end
    console.log(`Run directory: ${process.cwd()}`)
    console.log(`Output directory: ${resolve(process.cwd(), conf.FILES_DIR)}`)
    const report = await filterCheckRoutine({ start, end })
    console.log(`Filter-check CSV output: ${report.csvFile}`)
    console.log(`Filter-check excluded total: ${report.excludedCount}`)
  } else if (mode === "generate") {
    // generate the rewards from tags and tx counts.
    const stipend = BigNumber.from(conf.STIPEND)
    const maxReward = BigNumber.from(conf.MAX_REWARD)
    let tagsFilename = argv.tags
    let gasFilename = argv.gas

    if (!tagsFilename || !gasFilename) {
      const manifest = getLatestManifest()
      tagsFilename = manifest.generateTagsFile
      gasFilename = manifest.generateGasFile
      console.log(`Using latest manifest run ${manifest.runId}`)
    }

    const tags: Tag[] = JSON.parse(
      readFileSync(`./${conf.FILES_DIR}/${tagsFilename}`).toString()
    )
    const gasDunes: GasDune[] = JSON.parse(
      readFileSync(`./${conf.FILES_DIR}/${gasFilename}`).toString()
    )
    const rewards = await buildRewards(stipend, maxReward, tags, gasDunes)
    await buildCsv(rewards)
  } else if (mode === "send") {
    // disburse rewards
    const file = argv.rewards
    if (!file) throw new Error("JSON file needed to send the full rewards")
    const fileContent = readFileSync(`./${conf.FILES_DIR}/${file}`).toString()
    const rewards: Transaction[] = JSON.parse(fileContent)
    // rewrap the amounts onto BigNumber to recover their methods.
    rewards.forEach((reward) => {
      reward.amount = BigNumber.from(reward.amount)
    })
    await sendAllRewards(rewards)
  } else {
    throw new Error(`Unrecognized mode ${mode}`)
  }
}

main()
