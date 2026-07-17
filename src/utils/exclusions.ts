import { existsSync, readFileSync } from "fs"
import { AtqRow, Removal, Tag } from "../types"

// Manual exclusion list, applied when rewards are (re)computed. Lives at the
// repo root (committed, unlike files/) so every exclusion carries an audit
// trail in git history. See README "Exclusions" for the workflow.
export const EXCLUSIONS_PATH = process.env.EXCLUSIONS_FILE || "exclusions.json"

export type ExclusionScope = "submissions" | "removals" | "atq" | "all"

export interface Exclusion {
  // Match by tagged address (plus optional chain/registry narrowing)...
  tagAddress?: string
  chain?: string // CAIP chain reference, e.g. "1", "8453", or the Solana genesis hash
  registry?: Tag["registry"]
  // ...or by the Curate item (bare itemID, or the "<itemID>@<registry>" id).
  itemID?: string
  // Which reward kinds this entry applies to. Default: "all".
  scope?: ExclusionScope
  // Mandatory: why this entry exists. Shown in logs whenever it drops a reward.
  reason: string
}

interface TrackedExclusion extends Exclusion {
  hits: number
  label: string
}

export interface ExclusionList {
  entries: TrackedExclusion[]
  path: string
}

const SCOPES: ExclusionScope[] = ["submissions", "removals", "atq", "all"]
const REGISTRIES: Tag["registry"][] = ["addressTags", "tokens", "domains"]

// Fail loud on a malformed file: silently ignoring a typo here would pay out
// rewards the operator explicitly tried to withhold.
export const loadExclusions = (): ExclusionList => {
  if (!existsSync(EXCLUSIONS_PATH)) return { entries: [], path: EXCLUSIONS_PATH }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(EXCLUSIONS_PATH).toString())
  } catch (err) {
    throw new Error(`Could not parse ${EXCLUSIONS_PATH} as JSON: ${err}`)
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${EXCLUSIONS_PATH} must be a JSON array of exclusion entries.`)
  }

  const entries = raw.map((entry: Exclusion, i: number): TrackedExclusion => {
    const at = `${EXCLUSIONS_PATH}[${i}]`
    if (!entry || typeof entry !== "object") {
      throw new Error(`${at} is not an object.`)
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`${at} needs a non-empty "reason".`)
    }
    if (!entry.tagAddress && !entry.itemID) {
      throw new Error(`${at} needs "tagAddress" and/or "itemID" to match on.`)
    }
    if (entry.scope && !SCOPES.includes(entry.scope)) {
      throw new Error(`${at} has invalid scope "${entry.scope}". Use ${SCOPES.join("|")}.`)
    }
    if (entry.registry && !REGISTRIES.includes(entry.registry)) {
      throw new Error(
        `${at} has invalid registry "${entry.registry}". Use ${REGISTRIES.join("|")}.`
      )
    }
    if (entry.scope === "atq" && !entry.itemID) {
      throw new Error(`${at} has scope "atq", which matches by "itemID" only.`)
    }
    const label =
      entry.itemID ??
      `${entry.tagAddress}${entry.chain ? ` (chain ${entry.chain})` : ""}${
        entry.registry ? ` [${entry.registry}]` : ""
      }`
    return { ...entry, hits: 0, label }
  })

  console.log(`[exclusions] Loaded ${entries.length} entrie(s) from ${EXCLUSIONS_PATH}`)
  return { entries, path: EXCLUSIONS_PATH }
}

const norm = (s?: string): string => (s || "").trim().toLowerCase()

const scopeApplies = (entry: Exclusion, scope: ExclusionScope): boolean =>
  (entry.scope ?? "all") === "all" || entry.scope === scope

// entry.itemID matches the bare itemID or the "<itemID>@<registry>" id form.
const itemIdMatches = (entry: Exclusion, id?: string, itemID?: string): boolean => {
  if (!entry.itemID) return false
  const wanted = norm(entry.itemID).split("@")[0]
  return norm(itemID) === wanted || norm(id).split("@")[0] === wanted
}

const addressMatches = (
  entry: Exclusion,
  tagAddress?: string,
  chain?: string,
  registry?: Tag["registry"]
): boolean => {
  if (!entry.tagAddress || norm(entry.tagAddress) !== norm(tagAddress)) return false
  if (entry.chain && norm(entry.chain) !== norm(chain)) return false
  if (entry.registry && entry.registry !== registry) return false
  return true
}

const applyScoped = <T>(
  list: ExclusionList,
  scope: ExclusionScope,
  items: T[],
  matcher: (entry: Exclusion, item: T) => boolean,
  describe: (item: T) => string
): T[] => {
  const applicable = list.entries.filter((entry) => scopeApplies(entry, scope))
  if (applicable.length === 0) return items

  const kept: T[] = []
  for (const item of items) {
    const hit = applicable.find((entry) => matcher(entry, item))
    if (hit) {
      hit.hits++
      console.log(`[exclusions] Dropping ${scope} ${describe(item)} — ${hit.reason}`)
    } else {
      kept.push(item)
    }
  }
  return kept
}

export const applyTagExclusions = (list: ExclusionList, tags: Tag[]): Tag[] =>
  applyScoped(
    list,
    "submissions",
    tags,
    (entry, tag) =>
      itemIdMatches(entry, tag.id) ||
      addressMatches(entry, tag.tagAddress, tag.chain, tag.registry),
    (tag) => `${tag.tagAddress} (chain ${tag.chain}) [${tag.registry}]`
  )

export const applyRemovalExclusions = (
  list: ExclusionList,
  removals: Removal[]
): Removal[] =>
  applyScoped(
    list,
    "removals",
    removals,
    (entry, removal) =>
      itemIdMatches(entry, removal.id, removal.itemID) ||
      addressMatches(entry, removal.tagAddress, removal.chain, removal.registry),
    (removal) =>
      `${removal.tagAddress || removal.itemID} (chain ${removal.chain}) [${removal.registry}]`
  )

export const applyAtqExclusions = (
  list: ExclusionList,
  rows: AtqRow[],
  kind: "registered" | "removed"
): AtqRow[] =>
  applyScoped(
    list,
    "atq",
    rows,
    (entry, row) => itemIdMatches(entry, row.itemID, row.itemID),
    (row) => `${kind} ${row.itemID}`
  )

// An exclusion that matched nothing is usually a typo (wrong chain id, checksum
// pasted into itemID, ...). Warn per mode, over the scopes that mode applied.
export const warnUnmatchedExclusions = (
  list: ExclusionList,
  scopes: ExclusionScope[]
): void => {
  for (const entry of list.entries) {
    if (entry.hits > 0) continue
    if (!scopes.some((scope) => scopeApplies(entry, scope))) continue
    console.warn(
      `[exclusions] WARNING: entry ${entry.label} (${entry.reason}) matched nothing — ` +
        "check for typos (address, chain id, registry, itemID)."
    )
  }
}
