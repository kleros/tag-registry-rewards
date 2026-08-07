import { existsSync, readFileSync, writeFileSync } from "fs"
import conf from "./config"
import {
  AtqRewardRecord,
  CurateIndexEntry,
  FetchManifest,
  GenerateManifest,
  Period,
  RemovalsManifest,
  RewardRecord,
} from "./types"
import {
  buildCurateSnapshot,
  updateCurateIndex,
  writeCurateSnapshot,
} from "./utils/curate-document"
import { uploadToIpfs } from "./utils/file-to-ipfs"

const readJson = <T>(filename: string): T =>
  JSON.parse(readFileSync(`./${conf.FILES_DIR}/${filename}`).toString()) as T

// The document inputs are the *_rewards.json record files, NOT the send
// transactions files (<runId>.json / *_transactions.json), whose amounts
// serialize as BigNumber {type,hex} objects and carry no breakdown fields.
// Mixing them up would silently publish a snapshot with undefined registries
// and unreadable amounts — fail loud instead.
const assertRecords = (
  records: unknown,
  file: string,
  requiredStringFields: string[]
): void => {
  if (!Array.isArray(records)) {
    throw new Error(`[document] ${file} is not a JSON array of reward records.`)
  }
  records.forEach((record: any, i: number) => {
    for (const field of requiredStringFields) {
      if (typeof record?.[field] !== "string" || record[field].length === 0) {
        throw new Error(
          `[document] ${file}[${i}] has no string "${field}" — this doesn't ` +
            "look like a rewards record file. Pass the <runId>_rewards.json / " +
            "<runId>_removals.json / <runId>_atq.json file, not the send " +
            "transactions file."
        )
      }
    }
    if (!/^\d+$/.test(record.amount)) {
      throw new Error(
        `[document] ${file}[${i}].amount is not a decimal wei string — pass ` +
          "the rewards record file, not the send transactions file."
      )
    }
  })
}

const resolveSubmissions = (explicit?: string): RewardRecord[] => {
  let file = explicit
  if (!file) {
    const manifestPath = `./${conf.FILES_DIR}/latest_generate_manifest.json`
    if (existsSync(manifestPath)) {
      file = (JSON.parse(readFileSync(manifestPath).toString()) as GenerateManifest)
        .rewardsFile
    }
  }
  if (!file) {
    console.warn(
      "[document] No submission rewards file found (run `generate` first, or pass --submissions). Using none."
    )
    return []
  }
  if (!existsSync(`./${conf.FILES_DIR}/${file}`)) {
    console.warn(`[document] Submissions file ${file} not found. Using none.`)
    return []
  }
  console.log(`[document] Submissions from ${file}`)
  const records = readJson<RewardRecord[]>(file)
  assertRecords(records, file, ["recipient", "registry", "amount"])
  return records
}

const resolveRemovals = (explicit?: string): RewardRecord[] => {
  let file = explicit
  if (!file) {
    const manifestPath = `./${conf.FILES_DIR}/latest_removals_manifest.json`
    if (existsSync(manifestPath)) {
      file = (JSON.parse(readFileSync(manifestPath).toString()) as RemovalsManifest)
        .removalsJsonFile
    }
  }
  if (!file) {
    console.warn(
      "[document] No removals file found (run `removals` first, or pass --removals). Using none."
    )
    return []
  }
  if (!existsSync(`./${conf.FILES_DIR}/${file}`)) {
    console.warn(`[document] Removals file ${file} not found. Using none.`)
    return []
  }
  console.log(`[document] Removals from ${file}`)
  const records = readJson<RewardRecord[]>(file)
  assertRecords(records, file, ["recipient", "registry", "amount"])
  return records
}

const resolveAtq = (explicit?: string, removalsFile?: string): AtqRewardRecord[] => {
  let file = explicit
  // ATQ and removals are produced by the same run and share a runId prefix
  // (<runId>_removals.json / <runId>_atq.json). When removals is pinned
  // explicitly, pair it with its sibling ATQ file rather than the latest run.
  if (!file && removalsFile && /_removals\.json$/.test(removalsFile)) {
    file = removalsFile.replace(/_removals\.json$/, "_atq.json")
  } else if (!file && removalsFile) {
    console.warn(
      `[document] WARNING: --removals "${removalsFile}" doesn't match the ` +
        "<runId>_removals.json pattern, so its sibling ATQ file can't be " +
        "derived. The LATEST removals run's ATQ file will be used if one " +
        "exists (it may belong to a different period), otherwise NO ATQ " +
        "rewards are included. Pass --atq explicitly to pin it."
    )
  }
  if (!file) {
    const manifestPath = `./${conf.FILES_DIR}/latest_removals_manifest.json`
    if (existsSync(manifestPath)) {
      file = (JSON.parse(readFileSync(manifestPath).toString()) as RemovalsManifest)
        .atqRewardsJsonFile
    }
  }
  if (!file || !existsSync(`./${conf.FILES_DIR}/${file}`)) {
    if (file) console.warn(`[document] ATQ file ${file} not found. Using none.`)
    return []
  }
  console.log(`[document] ATQ from ${file}`)
  const records = readJson<AtqRewardRecord[]>(file)
  assertRecords(records, file, ["recipient", "itemID", "amount"])
  return records
}

const monthLabel = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

// Guard against publishing a mislabeled record: the latest removals and fetch
// manifests record their own periods, so warn if either doesn't match what
// we're documenting (only relevant when defaulting to the latest manifests,
// not explicit files).
const warnOnPeriodMismatch = (periodLabel: string): void => {
  const manifestPath = `./${conf.FILES_DIR}/latest_removals_manifest.json`
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(
        readFileSync(manifestPath).toString()
      ) as RemovalsManifest
      const removalsLabel = monthLabel(manifest.periodStart)
      if (removalsLabel !== periodLabel) {
        console.warn(
          `[document] WARNING: latest removals were computed for ${removalsLabel} but ` +
            `documenting ${periodLabel}. Pass --removals explicitly to avoid mixing periods.`
        )
      }
    } catch {
      /* ignore malformed manifest */
    }
  }
}

// Same guard for submissions. Two checks, because the rewards actually come
// from latest_generate_manifest.json (which records no period): the fetch
// manifest's period must match, AND generate must not predate the fetch it is
// supposed to have consumed (a stale generate would publish old amounts).
const warnOnSubmissionsPeriodMismatch = (periodLabel: string): void => {
  const fetchPath = `./${conf.FILES_DIR}/latest_fetch_manifest.json`
  if (!existsSync(fetchPath)) return
  try {
    const fetchManifest = JSON.parse(
      readFileSync(fetchPath).toString()
    ) as FetchManifest
    if (fetchManifest.periodStart) {
      const fetchLabel = monthLabel(fetchManifest.periodStart)
      if (fetchLabel !== periodLabel) {
        console.warn(
          `[document] WARNING: latest fetch (submissions) was for ${fetchLabel} but ` +
            `documenting ${periodLabel}. Pass --submissions explicitly to avoid mixing periods.`
        )
      }
    }
    const generatePath = `./${conf.FILES_DIR}/latest_generate_manifest.json`
    if (existsSync(generatePath)) {
      const generateManifest = JSON.parse(
        readFileSync(generatePath).toString()
      ) as GenerateManifest
      if (
        new Date(generateManifest.generatedAt).getTime() <
        new Date(fetchManifest.generatedAt).getTime()
      ) {
        console.warn(
          "[document] WARNING: latest generate output predates the latest fetch — " +
            "its rewards were built from an OLDER fetch. Run `--mode generate` " +
            "again (or pass --submissions explicitly) before documenting."
        )
      }
    }
  } catch {
    /* ignore malformed manifest */
  }
}

export const documentRoutine = async (opts: {
  period: Period
  periodLabel: string
  submissionsFile?: string
  removalsFile?: string
  atqFile?: string
}): Promise<CurateIndexEntry> => {
  if (!opts.removalsFile) warnOnPeriodMismatch(opts.periodLabel)
  if (!opts.submissionsFile) warnOnSubmissionsPeriodMismatch(opts.periodLabel)
  const submissions = resolveSubmissions(opts.submissionsFile)
  const removals = resolveRemovals(opts.removalsFile)
  const atq = resolveAtq(opts.atqFile, opts.removalsFile)

  const snapshot = buildCurateSnapshot(
    opts.periodLabel,
    opts.period,
    submissions,
    removals,
    atq
  )
  console.log(
    `[document] ${opts.periodLabel}: ${snapshot.totals.recipientCount} recipients, ` +
      `${submissions.length} submissions + ${removals.length} removals + ${atq.length} ATQ`
  )

  const { file, path } = writeCurateSnapshot(snapshot)
  console.log(`[document] Wrote ${path}`)

  const upload = await uploadToIpfs(path)
  if (upload) console.log(`[document] IPFS: ${upload.url}`)

  const entry: CurateIndexEntry = {
    period: opts.periodLabel,
    cid: upload?.cid ?? null,
    url: upload?.url ?? null,
    file,
    generatedAt: snapshot.generatedAt,
    total: snapshot.totals.total,
    recipientCount: snapshot.totals.recipientCount,
  }
  const index = updateCurateIndex(entry)
  console.log(`[document] Updated ${conf.FILES_DIR}/curate-rewards-index.json`)

  // Frontends (e.g. the rewards dashboard) consume a plain array of snapshot
  // URLs rather than the rich entry objects — emit that form alongside.
  const urls = index
    .map((e) => e.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0)
  writeFileSync(
    `./${conf.FILES_DIR}/curate-rewards-index.urls.json`,
    JSON.stringify(urls, null, 1),
    { encoding: "utf-8" }
  )
  console.log(`[document] Wrote ${conf.FILES_DIR}/curate-rewards-index.urls.json`)

  // files/ is gitignored, so on a fresh machine this index only contains the
  // periods generated locally — publishing it wholesale would erase history.
  console.warn(
    `[document] Publish: the local index holds ${index.length} period(s). The ` +
      "deployed index likely holds more — MERGE this period's entry/URL into the " +
      "frontend's existing index (gtcr public/data/, rewards-dashboard " +
      "src/assets/); never overwrite it with this file wholesale."
  )

  return entry
}
