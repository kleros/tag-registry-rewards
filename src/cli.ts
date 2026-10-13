import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"
import { FetchManifest, GasDune, Tag } from "./types"
import conf from "./config"
import yargs = require("yargs")
import { hideBin } from "yargs/helpers"
import buildCsv, { GenerateSource } from "./csv"
import { existsSync, readdirSync, readFileSync } from "fs"
import { resolve } from "path"
import { inspect } from "util"
import { prefetchRoutine, tagsRoutine } from "./tags-routine"
import { filterCheckRoutine } from "./filter-check-routine"
import { removalsRoutine } from "./removals-routine"
import { documentRoutine } from "./document-routine"
import { verifyTxCounts } from "./verify-tx-counts"
import { listDisbursementsRoutine, sendRoutine } from "./send-routine"
import { redactSecrets } from "./utils/solana-rpc"
import { isBudgetExceeded, setTimeBudget } from "./utils/runtime-helpers"
import { txCountCacheDir, txCountCacheEnabled } from "./utils/tx-count-cache"
import { getEvmTxProvider } from "./utils/evm-enrichment"
import { getSolanaTxProvider } from "./utils/solana-enrichment"
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
    Send rewards (refuses a file or period already paid; resumes an interrupted send):
      $0 --mode send --rewards \${filename}.json [--dry-run] [--period YYYY-MM when no manifest gives it]
    List what was sent (the disbursement ledger):
      $0 --mode disbursements
    Check the tx-count providers (HyperSync, Solana RPC) against known values:
      $0 --mode verify-counts
    Optional: count this month's tags so far into the cache (no payout files),
    so the month-end fetch only tops up; resumable:
      $0 --mode prefetch [--max-minutes N]`
  )
  .option("m", {
    description:
      "The mode of the execution. Steps: 'fetch', 'filter-check', 'removals', 'generate', 'document', 'all', 'send', 'disbursements', 'verify-counts', and 'prefetch'",
    alias: "mode",
  })
  .option("max-minutes", {
    description:
      "fetch/prefetch/all: stop counting transactions this many minutes after counting starts, with progress saved; rerun to continue",
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
    description: "The month (YYYY-MM) to work on; for send, the month paid by a file whose manifest gives no period",
  })
  .option("submissions", {
    description: "Submission rewards JSON file for the document mode",
  })
  .option("removals", {
    description: "Removals rewards JSON file for the document mode",
  })
  .option("atq", {
    description: "ATQ rewards JSON file for the document mode",
  })
  .option("dry-run", {
    description: "send: show what would be sent and every check, without signing or recording anything",
    type: "boolean",
  })
  .option("allow-repeat-period", {
    description: "send: pay although another file for the same period and kind was already paid",
    type: "boolean",
  })
  .option("skip-paid-on-chain", {
    description: "send: count the transfers already found on-chain as paid and send the rest",
    type: "boolean",
  })
  .option("skip-onchain-check", {
    description: "send: do not look for this payout's transfers among the wallet's past transfers",
    type: "boolean",
  })
  .option("from", {
    description: "send --dry-run: check as this address, without its key (e.g. was this file paid?)",
    type: "string",
  })
  .option("forget-unmined", {
    description: "send: resend a transfer whose saved transactions can no longer be mined (their nonce went to another transaction)",
    type: "boolean",
  }).argv

// Strict YYYY-MM-DD: Date.UTC would roll "2026-13-01" over to January 2027.
const parseDate = (s: string): Date => {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim())
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [NaN, NaN, NaN]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (!match || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`Invalid date "${s}". Expected YYYY-MM-DD.`)
  }
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

// The fetch manifest (of any run) that wrote this tags file, if it is here.
const fetchManifestFor = (tagsFile: string): FetchManifest | null => {
  const dir = `./${conf.FILES_DIR}`
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir).filter((n) => /(^|_)fetch_manifest\.json$/.test(n))) {
    try {
      const manifest = JSON.parse(readFileSync(`${dir}/${name}`).toString()) as FetchManifest
      if (manifest.generateTagsFile === tagsFile) return manifest
    } catch {
      // not a manifest
    }
  }
  return null
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
  if (start.getTime() >= end.getTime()) {
    throw new Error(`Invalid period: ${start.toISOString()} is not before ${end.toISOString()}.`)
  }
  return { start, end, label: toPeriodLabel(start) }
}

// Prefetch counts the month that is still running: without --period/--start/
// --end it takes the current UTC month, every tag registered in it so far.
const resolvePrefetchPeriod = (): { start: Date; end: Date; label: string } => {
  if (argv.period || argv.start || argv.end) return resolvePeriod()
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end, label: toPeriodLabel(start) }
}

// --max-minutes: both tx-count lanes stop before their next request once it
// has passed since counting started, with everything counted so far saved in
// the cache. Fetching and filtering the tags before it is not counted. Without
// the cache, or with a Dune lane (no cache), a stop would keep nothing and
// every rerun would start over, so it is refused.
const applyTimeBudget = (): void => {
  const raw = argv["max-minutes"]
  if (raw === undefined) return
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid --max-minutes "${raw}": expected a positive number`)
  }
  if (!txCountCacheEnabled()) {
    throw new Error("--max-minutes needs the tx-count cache to resume (TX_COUNT_CACHE is off)")
  }
  if (getEvmTxProvider() === "dune" || getSolanaTxProvider() === "dune") {
    throw new Error("--max-minutes only works with the hypersync and rpc providers; the Dune providers keep no cache")
  }
  setTimeBudget(minutes)
  console.log(`Time budget: transaction counting stops ${minutes} minute(s) after it starts, progress saved`)
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

  // The period of the fetch the rewards come from, recorded for `send`.
  let source: GenerateSource
  if (!tagsFilename || !gasFilename) {
    const manifest = getLatestManifest()
    tagsFilename = manifest.generateTagsFile
    gasFilename = manifest.generateGasFile
    source = { periodStart: manifest.periodStart, periodEnd: manifest.periodEnd }
    console.log(`Using latest manifest run ${manifest.runId}`)
  } else {
    const manifest = fetchManifestFor(tagsFilename)
    source = manifest ? { periodStart: manifest.periodStart, periodEnd: manifest.periodEnd } : {}
  }
  if (!source.periodStart || !source.periodEnd) {
    console.warn(
      `[generate] WARNING: no fetch manifest in ${conf.FILES_DIR}/ gives the period of ${tagsFilename}, so these rewards ` +
        "carry none: send will refuse them until --period YYYY-MM gives their month."
    )
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
  const manifest = await buildCsv(rewards, { ...source, tagsFile: tagsFilename, gasFile: gasFilename })
  console.log(`Transactions file (for --mode send): ${manifest.transactionsFile}`)
}

const main = async () => {
  const mode = argv.mode as string | undefined
  if (mode === undefined) {
    throw new Error(
      "You must choose a mode, 'fetch' | 'filter-check' | 'removals' | 'generate' | 'document' | 'all' | 'send' | 'disbursements' | 'verify-counts' | 'prefetch'"
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
    applyTimeBudget()
    let manifest: FetchManifest
    try {
      manifest = await tagsRoutine({ start, end })
    } catch (err) {
      if (!isBudgetExceeded(err)) throw err
      console.log(
        `Fetch stopped at --max-minutes with counts incomplete; no output was written. ` +
          `Progress is saved in ${txCountCacheDir()}: rerun the same command to continue.`
      )
      process.exitCode = 2
      return
    }
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
    applyTimeBudget()
    try {
      await tagsRoutine({ start, end })
    } catch (err) {
      if (!isBudgetExceeded(err)) throw err
      console.log(
        `[all] Stopped at --max-minutes with counts incomplete; nothing was generated. ` +
          `Progress is saved in ${txCountCacheDir()}: rerun to continue.`
      )
      process.exitCode = 2
      return
    }

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
    // disburse rewards, recorded in the disbursement ledger (refuses repeats)
    const file = argv.rewards
    if (!file) throw new Error("JSON file needed to send the full rewards: --rewards <transactions file>")
    await sendRoutine({
      file: String(file),
      dryRun: !!argv["dry-run"],
      allowRepeatPeriod: !!argv["allow-repeat-period"],
      skipPaidOnChain: !!argv["skip-paid-on-chain"],
      skipOnchainCheck: !!argv["skip-onchain-check"],
      forgetUnmined: !!argv["forget-unmined"],
      from: argv.from ? String(argv.from) : undefined,
      period: argv.period ? String(argv.period) : undefined,
    })
  } else if (mode === "disbursements") {
    listDisbursementsRoutine()
  } else if (mode === "verify-counts") {
    // check the tx-count providers against known values before a real fetch.
    const ok = await verifyTxCounts()
    if (!ok) process.exitCode = 1
  } else if (mode === "prefetch") {
    // count the running month's tags into the cache so the month-end fetch
    // only tops up; writes no payout files. A stop at --max-minutes is normal.
    const { start, end, label } = resolvePrefetchPeriod()
    console.log(`Prefetch period: ${label} (${start.toISOString()} → ${end.toISOString()})`)
    applyTimeBudget()
    const started = Date.now()
    const { complete } = await prefetchRoutine({ start, end })
    console.log(`Prefetch ${complete ? "finished" : "paused"} after ${Math.round((Date.now() - started) / 60000)} min`)
  } else {
    throw new Error(`Unrecognized mode ${mode}`)
  }
}

// Explicit catch so failures exit non-zero on every Node version (an unhandled
// rejection only crashes on Node >= 15) — cron/CI wrappers rely on the code.
// Network errors embed request URLs, and those can carry API keys (Solana RPC
// URLs, the subgraph URL): the error is printed redacted.
main().catch((err) => {
  const keyedUrls = String(process.env.SOLANA_RPC_URLS || "")
    .split(",")
    .concat(String(conf.XDAI_GTCR_SUBGRAPH_URL || ""))
  console.error(redactSecrets(inspect(err), keyedUrls))
  process.exit(1)
})
