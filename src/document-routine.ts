import { existsSync, readFileSync } from "fs"
import conf from "./config"
import {
  AtqRewardRecord,
  CurateIndexEntry,
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
  return readJson<RewardRecord[]>(file)
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
  return readJson<RewardRecord[]>(file)
}

const resolveAtq = (explicit?: string, removalsFile?: string): AtqRewardRecord[] => {
  let file = explicit
  // ATQ and removals are produced by the same run and share a runId prefix
  // (<runId>_removals.json / <runId>_atq.json). When removals is pinned
  // explicitly, pair it with its sibling ATQ file rather than the latest run.
  if (!file && removalsFile && /_removals\.json$/.test(removalsFile)) {
    file = removalsFile.replace(/_removals\.json$/, "_atq.json")
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
  return readJson<AtqRewardRecord[]>(file)
}

const monthLabel = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

// Guard against publishing a mislabeled record: the latest removals manifest
// records its own period, so warn if it doesn't match what we're documenting
// (only relevant when defaulting to the latest manifest, not an explicit file).
const warnOnPeriodMismatch = (periodLabel: string): void => {
  const manifestPath = `./${conf.FILES_DIR}/latest_removals_manifest.json`
  if (!existsSync(manifestPath)) return
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

export const documentRoutine = async (opts: {
  period: Period
  periodLabel: string
  submissionsFile?: string
  removalsFile?: string
  atqFile?: string
}): Promise<CurateIndexEntry> => {
  if (!opts.removalsFile) warnOnPeriodMismatch(opts.periodLabel)
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
  updateCurateIndex(entry)
  console.log(`[document] Updated ${conf.FILES_DIR}/curate-rewards-index.json`)
  console.log(
    "[document] Publish: copy the index (+ snapshot, unless on IPFS) into the " +
      "gtcr frontend's public/data/ to update the rewards page."
  )

  return entry
}
