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
import { removalsRoutine } from "./removals-routine"
import { documentRoutine } from "./document-routine"
import {
  applyTagExclusions,
  ExclusionList,
  loadExclusions,
  warnUnmatchedExclusions,
} from "./utils/exclusions"

// Default period: the previous calendar month, computed purely in UTC.
// (The old local-time + offset arithmetic used the CURRENT date's DST offset
// for both boundaries, so runs in the month after a DST transition shifted
// the window into the wrong UTC month.)
const getExpectedDates = (): { start: Date; end: Date } => {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
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
    Detect removals + ATQ reports:
      $0 --mode removals --start <start-date> --end <end-date>
    Generate rewards file:
      $0 --mode generate --tags \${filename}.json --gas \${filename}.json
      $0 --mode generate # uses files/latest_fetch_manifest.json
    Document rewards to IPFS:
      $0 --mode document --period YYYY-MM
      $0 --mode document # merges latest generate + removals outputs
    Run the full compute + publish (everything except send):
      $0 --mode all --period YYYY-MM
    Send rewards:
      $0 --mode send --rewards \${filename}.json`
  )
  .option("m", {
    description:
      "The mode of the execution. Steps: 'fetch', 'filter-check', 'removals', 'generate', 'document', 'all', and 'send'",
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
  })
  .option("period", {
    description: "Period label (YYYY-MM) for the document mode",
  })
  .option("submissions", {
    description: "Submission rewards JSON file for the document mode",
  })
  .option("removals", {
    description: "Removals rewards JSON file for the document mode",
  })
  .option("atq", {
    description: "ATQ rewards JSON file for the document mode",
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

const toPeriodLabel = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`

// Resolve the reward period from CLI flags. `--period YYYY-MM` derives the whole
// month window; explicit `--start`/`--end` win; otherwise defaults to last month.
// The label is always derived from the resolved `start`, so it stays normalized
// (zero-padded) and can never disagree with the actual window.
const resolvePeriod = (): { start: Date; end: Date; label: string } => {
  let { start, end } = getExpectedDates()
  if (argv.period && (argv.start || argv.end)) {
    throw new Error(
      "--period cannot be combined with --start/--end: pass either the month " +
        "label or an explicit window, not both."
    )
  }
  if (argv.period && !argv.start && !argv.end) {
    // Strict YYYY-MM only: a loose split would silently accept "2026-07-15"
    // (probably meant as --start) and document the whole month instead.
    const match = /^(\d{4})-(\d{2})$/.exec(String(argv.period).trim())
    const [y, m] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
    if (!match || m < 1 || m > 12) {
      throw new Error(`Invalid --period "${argv.period}". Expected YYYY-MM.`)
    }
    start = new Date(Date.UTC(y, m - 1, 1))
    end = new Date(Date.UTC(y, m, 1))
  } else {
    start = argv.start ? parseDate(argv.start) : start
    end = argv.end ? parseDate(argv.end) : end
  }
  return { start, end, label: toPeriodLabel(start) }
}

// Build submission rewards from the given tags/gas files, or the latest fetch
// manifest when omitted. Shared by `generate` and `all`. When `all` passes its
// shared exclusion list, hits accumulate across steps and the unmatched-entry
// check runs once at the end instead of per step (a scope:"all" entry that
// matches only a removal would otherwise falsely warn here).
const runGenerate = async (
  tagsFilename?: string,
  gasFilename?: string,
  sharedExclusions?: ExclusionList
): Promise<void> => {
  const stipend = BigNumber.from(conf.STIPEND)
  const maxReward = BigNumber.from(conf.MAX_REWARD)

  if (!tagsFilename || !gasFilename) {
    const manifest = getLatestManifest()
    tagsFilename = manifest.generateTagsFile
    gasFilename = manifest.generateGasFile
    console.log(`Using latest manifest run ${manifest.runId}`)
  }

  const allTags: Tag[] = JSON.parse(
    readFileSync(`./${conf.FILES_DIR}/${tagsFilename}`).toString()
  )
  const gasDunes: GasDune[] = JSON.parse(
    readFileSync(`./${conf.FILES_DIR}/${gasFilename}`).toString()
  )
  // Drop manually excluded tags before the pool math so their share is
  // redistributed to the remaining submissions (see README "Exclusions").
  const exclusions = sharedExclusions ?? loadExclusions()
  const tags = applyTagExclusions(exclusions, allTags)
  if (tags.length !== allTags.length) {
    console.log(
      `[exclusions] ${allTags.length - tags.length} submission(s) excluded, ` +
        `${tags.length} remain.`
    )
  }
  if (!sharedExclusions) warnUnmatchedExclusions(exclusions, ["submissions"])
  const rewards = await buildRewards(stipend, maxReward, tags, gasDunes)
  await buildCsv(rewards)
}

const main = async () => {
  const mode = argv.mode as string | undefined
  if (mode === undefined) {
    throw new Error(
      "You must choose a mode, 'fetch' | 'filter-check' | 'removals' | 'generate' | 'document' | 'all' | 'send'"
    )
  }
  if (mode === "fetch") {
    // fetch the tags according to a period. first step.
    // after operator generates the tags, follow the instructions and run `generate` next.
    const { start, end, label } = resolvePeriod()
    console.log(`Fetch period: ${label} (${start.toISOString()} → ${end.toISOString()})`)
    const fetchStart = new Date()
    console.log(`Fetch started at: ${fetchStart.toISOString()}`)
    console.log(`Run directory: ${process.cwd()}`)
    console.log(`Output directory: ${resolve(process.cwd(), conf.FILES_DIR)}`)
    const manifest = await tagsRoutine({ start, end })
    console.log(`Fetch CSV output: ${manifest.fullCsvFile}`)
    console.log(`Generate tags file: ${manifest.generateTagsFile}`)
    console.log(`Generate gas file: ${manifest.generateGasFile}`)
    const fetchEnd = new Date()
    const elapsedMs = fetchEnd.getTime() - fetchStart.getTime()
    const elapsedMin = Math.floor(elapsedMs / 60000)
    const elapsedSec = Math.floor((elapsedMs % 60000) / 1000)
    console.log(`Fetch ended at: ${fetchEnd.toISOString()}`)
    console.log(`Total fetch time: ${elapsedMin}m ${elapsedSec}s`)
  } else if (mode === "filter-check") {
    const { start, end, label } = resolvePeriod()
    console.log(`Filter-check period: ${label} (${start.toISOString()} → ${end.toISOString()})`)
    console.log(`Run directory: ${process.cwd()}`)
    console.log(`Output directory: ${resolve(process.cwd(), conf.FILES_DIR)}`)
    const report = await filterCheckRoutine({ start, end })
    console.log(`Filter-check CSV output: ${report.csvFile}`)
    console.log(`Filter-check excluded total: ${report.excludedCount}`)
  } else if (mode === "removals") {
    // detect removals (items removed within the period) and reward the removers,
    // plus emit the ATQ registered/removed informational reports. The transactions
    // file it writes is compatible with `--mode send`.
    const { start, end, label } = resolvePeriod()
    console.log(`Removals period: ${label} (${start.toISOString()} → ${end.toISOString()})`)
    console.log(`Run directory: ${process.cwd()}`)
    console.log(`Output directory: ${resolve(process.cwd(), conf.FILES_DIR)}`)
    const manifest = await removalsRoutine({ start, end })
    console.log(`Removals CSV output: ${manifest.removalsCsvFile}`)
    console.log(`Removals transactions file: ${manifest.transactionsFile}`)
    console.log(`ATQ transactions file: ${manifest.atqTransactionsFile}`)
    console.log(`ATQ registered CSV: ${manifest.atqRegisteredCsvFile}`)
    console.log(`ATQ removed CSV: ${manifest.atqAbsentCsvFile}`)
  } else if (mode === "document") {
    // merge submission + removal rewards for a period into one structured JSON,
    // upload it to IPFS, and update the index the public page reads.
    const { start, end, label: periodLabel } = resolvePeriod()
    const entry = await documentRoutine({
      period: { start, end },
      periodLabel,
      submissionsFile: argv.submissions,
      removalsFile: argv.removals,
      atqFile: argv.atq,
    })
    console.log(`Document period: ${entry.period}`)
    console.log(`Recipients: ${entry.recipientCount}`)
    if (entry.url) console.log(`IPFS URL: ${entry.url}`)
  } else if (mode === "generate") {
    // generate the rewards from tags and tx counts.
    await runGenerate(argv.tags, argv.gas)
  } else if (mode === "all") {
    // run the full monthly compute + publish in order: fetch -> generate ->
    // removals -> document. `send` is intentionally NOT included: it moves real
    // PNK on-chain and must be run manually after reviewing the amounts.
    const { start, end, label: periodLabel } = resolvePeriod()
    console.log(`=== [all] period ${periodLabel} (${start.toISOString()} -> ${end.toISOString()}) ===`)

    // One exclusion list shared across generate + removals, so hits accumulate
    // and the unmatched check below sees every scope of the whole run.
    const exclusions = loadExclusions()

    console.log("\n=== [all] 1/4 fetch (submissions) ===")
    await tagsRoutine({ start, end })

    console.log("\n=== [all] 2/4 generate (submissions) ===")
    await runGenerate(undefined, undefined, exclusions)

    console.log("\n=== [all] 3/4 removals + ATQ ===")
    const removalsManifest = await removalsRoutine({ start, end }, exclusions)
    warnUnmatchedExclusions(exclusions, ["submissions", "removals", "atq"])

    console.log("\n=== [all] 4/4 document (IPFS) ===")
    const entry = await documentRoutine({ period: { start, end }, periodLabel })

    console.log("\n=== [all] done ===")
    console.log(`Documented ${entry.recipientCount} recipients for ${entry.period}.`)
    if (entry.url) console.log(`IPFS URL: ${entry.url}`)
    // Print the exact filenames — submissions use the generate run's timestamp,
    // removals/ATQ the removals run's, so a single <runId> placeholder misleads.
    let submissionsTxFile = "<see latest_generate_manifest.json: transactionsFile>"
    try {
      submissionsTxFile = (JSON.parse(
        readFileSync(`./${conf.FILES_DIR}/latest_generate_manifest.json`).toString()
      ) as { transactionsFile: string }).transactionsFile
    } catch {
      /* keep placeholder */
    }
    console.log(
      "Nothing was sent on-chain. Review the amounts, then disburse manually:\n" +
        `  yarn start --mode send --rewards ${submissionsTxFile}\n` +
        `  yarn start --mode send --rewards ${removalsManifest.transactionsFile}\n` +
        `  yarn start --mode send --rewards ${removalsManifest.atqTransactionsFile}`
    )
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

// Explicit catch so failures exit non-zero on every Node version (an unhandled
// rejection only crashes on Node >= 15) — cron/CI wrappers rely on the code.
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
