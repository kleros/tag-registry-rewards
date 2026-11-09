import { Item } from "../types"
import { sleep } from "../transaction-sender"
import { ExclusionList, submissionExclusionFor } from "./exclusions"
import { httpFetch } from "./http"
import { errorMessage } from "./runtime-helpers"

// The indexer fills an item's key0…key3 from the item's IPFS file when it
// indexes it, and leaves them all empty when that one fetch failed: it caches
// the failure (gtcr-indexer PR #11). Such an item is registered like any other
// but has no address, so it was skipped, unpaid, while its share went to the
// others (October 2026: USD1 and ALLO in Tokens, one Domains entry). Its keys
// are read here from the same file, derived the way the indexer derives them:
// the values of the identifier columns, in column order.

// IPFS_READ_GATEWAYS (comma-separated, each ending in /ipfs) is tried in order.
export const ipfsReadGateways = (): string[] => {
  const listed = String(process.env.IPFS_READ_GATEWAYS || "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean)
  if (listed.length > 0) return listed
  return [String(process.env.IPFS_GATEWAY || "https://cdn.kleros.link/ipfs").replace(/\/+$/, ""), "https://ipfs.io/ipfs"]
}

// The "<cid>/<path>" of an item's data, however it is written: "/ipfs/<cid>…",
// "ipfs://<cid>…", a gateway URL ("https://<host>/ipfs/<cid>…") or a bare CID.
// Null when it names no IPFS file.
export const ipfsPath = (data: string): string | null => {
  const text = data.trim()
  const m = /^(?:\/ipfs\/|ipfs:\/\/|https?:\/\/[^/]+\/ipfs\/)(.+)$/.exec(text)
  if (m) return m[1]
  return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(?:\/\S*)?$/.test(text) ? text : null
}

// A value as the indexer stores it (JSONValueToMaybeString).
const asKey = (value: unknown): string => {
  if (value === null || value === undefined) return "-"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return value.toString()
  return "-"
}

type Keys = Pick<Item, "key0" | "key1" | "key2" | "key3">

// The keys of an item file ({ columns, values }), or null when it has none.
export const keysFromItemFile = (file: unknown): Keys | null => {
  const { columns, values } = (file || {}) as { columns?: unknown; values?: unknown }
  if (!Array.isArray(columns) || !values || typeof values !== "object") return null
  const keys: string[] = []
  columns.forEach((column: { label?: unknown; isIdentifier?: unknown } | null, i: number) => {
    if (!column || column.isIdentifier !== true) return
    const label = column.label ? String(column.label) : `missing-label${i}`
    keys.push(asKey((values as { [label: string]: unknown })[label]))
  })
  if (keys.length === 0) return null
  return { key0: keys[0], key1: keys[1] ?? "", key2: keys[2] ?? "", key3: keys[3] ?? "" }
}

// The parsed file; null when every gateway served it and none of it is JSON (a
// malformed submission, which no retry will change).
const readItemFile = async (path: string): Promise<unknown> => {
  const gateways = ipfsReadGateways()
  const failures: string[] = []
  let unparsable = 0
  for (const gateway of gateways) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpFetch(`${gateway}/${path}`, { timeout: 30000, size: 1024 * 1024 })
        if (res.ok) {
          const text = await res.text()
          try {
            return JSON.parse(text)
          } catch {
            unparsable++
            failures.push(`${gateway}: not JSON`)
            break
          }
        }
        // a 4xx other than rate limiting will not change on a retry
        if (res.status < 500 && res.status !== 429) {
          failures.push(`${gateway}: HTTP ${res.status}`)
          break
        }
        throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        if (attempt === 3) failures.push(`${gateway}: ${errorMessage(err)}`)
        else await sleep(attempt)
      }
    }
  }
  if (unparsable === gateways.length) return null
  throw new Error(failures.join("; "))
}

// An item the indexer left blank whose address could not be found anywhere.
export interface UnresolvedItem {
  id: string
  why: string
}

// The items, with the keys of those the indexer left empty read from their IPFS
// file, and the ones whose address could still not be found, with why.
export const fillMissingKeys = async <T extends Item>(
  items: T[],
  what: string
): Promise<{ items: T[]; unresolved: UnresolvedItem[] }> => {
  const blank = items.filter((item) => !item.key0)
  if (blank.length === 0) return { items, unresolved: [] }
  console.log(`[${what}] ${blank.length} item(s) without key0 in the indexer: reading their IPFS files`)
  const filled = new Map<string, Keys>()
  const unresolved: UnresolvedItem[] = []
  for (const item of blank) {
    const path = item.data ? ipfsPath(item.data) : null
    if (!path) {
      unresolved.push({ id: item.id, why: `its data names no IPFS file (${JSON.stringify(item.data ?? null).slice(0, 120)})` })
      continue
    }
    let file: unknown
    try {
      file = await readItemFile(path)
    } catch (err) {
      unresolved.push({ id: item.id, why: `its IPFS file ${item.data} could not be read (${errorMessage(err)})` })
      continue
    }
    const keys = keysFromItemFile(file)
    if (!keys || !keys.key0 || keys.key0 === "-") {
      unresolved.push({ id: item.id, why: `its IPFS file ${item.data} names no address` })
      continue
    }
    console.log(`[${what}] ${item.id}: key0 ${keys.key0} read from ${item.data}`)
    filled.set(item.id, keys)
  }
  return {
    items: items.map((item) => (filled.has(item.id) ? { ...item, ...(filled.get(item.id) as Keys) } : item)),
    unresolved,
  }
}

// Every item that would be left out unpaid must be named in exclusions.json
// (by itemID, for submissions), or the run stops: an item is never dropped
// silently. Returns the ids left out on purpose.
export const assertAllResolved = (unresolved: UnresolvedItem[], exclusions: ExclusionList, what: string): Set<string> => {
  const leftOut = new Set<string>()
  const unexplained: UnresolvedItem[] = []
  for (const item of unresolved) {
    const entry = submissionExclusionFor(exclusions, item.id)
    if (entry) {
      console.warn(`[${what}] ${item.id} left out: ${item.why}; ${exclusions.path} names it (${entry.reason})`)
      leftOut.add(item.id)
    } else {
      unexplained.push(item)
    }
  }
  if (unexplained.length > 0) {
    throw new Error(
      `[${what}] ${unexplained.length} registered item(s) of the period cannot be read, and leaving them out would ` +
        `pay their share to the others:\n${unexplained.map((u) => `  ${u.id}: ${u.why}`).join("\n")}\n` +
        "Rerun if a gateway or the indexer failed (IPFS_READ_GATEWAYS sets the gateways). An item that cannot be read at all " +
        `is left out only once ${exclusions.path} names it: {"itemID": "<id>", "scope": "submissions", "reason": "…"}.`
    )
  }
  return leftOut
}
