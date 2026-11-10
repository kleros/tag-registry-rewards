import { Item } from "../types"
import { sleep } from "../transaction-sender"
import { ExclusionList, ExclusionScope, itemExclusionFor } from "./exclusions"
import { httpFetch } from "./http"
import { errorMessage } from "./runtime-helpers"

// The indexer fills an item's key0…key3 from the item's IPFS file when it
// indexes it, and leaves them all empty when that one fetch failed: it caches
// the failure (gtcr-indexer PR #11). Such an item is registered like any other
// but has no address, so it was skipped, unpaid, while its share went to the
// others (October 2026: USD1 and ALLO in Tokens, one Domains entry). Its keys
// are read here from the same file, derived the way the indexer derives them:
// the values of the identifier columns, in column order.

const withoutTrailingSlashes = (url: string): string => {
  let end = url.length
  while (end > 0 && url[end - 1] === "/") end--
  return url.slice(0, end)
}

// IPFS_READ_GATEWAYS (comma-separated, each ending in /ipfs) is tried in order.
export const ipfsReadGateways = (): string[] => {
  const listed = String(process.env.IPFS_READ_GATEWAYS || "")
    .split(",")
    .map((url) => withoutTrailingSlashes(url.trim()))
    .filter(Boolean)
  if (listed.length > 0) return listed
  return [withoutTrailingSlashes(String(process.env.IPFS_GATEWAY || "https://cdn.kleros.link/ipfs")), "https://ipfs.io/ipfs"]
}

// What the indexer strips from an item's data before fetching it (its
// extractPath), plus the URL forms: "/ipfs/<cid>…", "ipfs/<cid>…",
// "ipfs::/<cid>…", "/<cid>…", "ipfs://<cid>…", "https://<host>/ipfs/<cid>…".
const IPFS_PREFIXES = ["/ipfs/", "ipfs/", "ipfs::/", "ipfs://", "/"]
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(?:\/\S*)?$/

// The "<cid>/<path>" of an item's data, however it is written, or null when
// it names no IPFS file: after one of the prefixes, whatever follows (as the
// indexer reads it); without one, only a CID (data that is the item itself,
// inline JSON, is no file).
export const ipfsPath = (data: string): string | null => {
  const text = data.trim()
  const gateway = /^https?:\/\/[^/]+\/ipfs\//.exec(text)
  const prefix = gateway ? gateway[0] : IPFS_PREFIXES.find((p) => text.startsWith(p))
  if (prefix === undefined) return CID.test(text) ? text : null
  const path = text.slice(prefix.length)
  return path && !/\s/.test(path) ? path : null
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

const isItemFile = (file: unknown): boolean => {
  const { columns, values } = (file || {}) as { columns?: unknown; values?: unknown }
  return Array.isArray(columns) && !!values && typeof values === "object"
}

// One gateway's answer: the item file, or why not, and whether a retry there
// could change it (a 4xx other than rate limiting will not).
const readFrom = async (url: string): Promise<{ file?: unknown; failure?: string; retry: boolean }> => {
  const res = await httpFetch(url, { timeout: 30000, size: 1024 * 1024 })
  if (!res.ok) return { failure: `HTTP ${res.status}`, retry: res.status >= 500 || res.status === 429 }
  // A gateway can answer 200 with an error page or its own JSON: only an
  // item file ({ columns, values }) is an answer, anything else is asked of
  // the next gateway.
  try {
    const file = JSON.parse(await res.text())
    return isItemFile(file) ? { file, retry: false } : { failure: "not an item file", retry: false }
  } catch {
    return { failure: "not JSON", retry: false }
  }
}

// The item file at `path`, from the first gateway that serves one; throws,
// naming each gateway's answer, when none does.
const readItemFile = async (path: string): Promise<unknown> => {
  const failures: string[] = []
  for (const gateway of ipfsReadGateways()) {
    let failure = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      let retry = true
      try {
        const answer = await readFrom(`${gateway}/${path}`)
        if (answer.file) return answer.file
        failure = answer.failure || ""
        retry = answer.retry
      } catch (err) {
        failure = errorMessage(err)
      }
      if (!retry || attempt === 3) break
      await sleep(attempt)
    }
    failures.push(`${gateway}: ${failure}`)
  }
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

// A requester the indexer could not read: it stores the zero address when its
// read of the request failed, and paying that would burn the reward.
export const isMissingRequester = (requester?: string): boolean => !requester || /^0x0{40}$/i.test(requester.trim())

// Every item that would be left out unpaid must be named in exclusions.json
// (by itemID, in `scope`), or the run stops: an item is never dropped
// silently. Returns the ids left out on purpose.
export const assertAllResolved = (
  unresolved: UnresolvedItem[],
  exclusions: ExclusionList,
  what: string,
  scope: ExclusionScope = "submissions"
): Set<string> => {
  const leftOut = new Set<string>()
  const unexplained: UnresolvedItem[] = []
  for (const item of unresolved) {
    const entry = itemExclusionFor(exclusions, scope, item.id)
    if (entry) {
      console.warn(`[${what}] ${item.id} left out: ${item.why}; ${exclusions.path} names it (${entry.reason})`)
      leftOut.add(item.id)
    } else {
      unexplained.push(item)
    }
  }
  if (unexplained.length > 0) {
    const list = unexplained.map((u) => "  " + u.id + ": " + u.why).join("\n")
    throw new Error(
      `[${what}] ${unexplained.length} item(s) of the period cannot be read in full, and leaving them out would ` +
        `pay their share to the others, or nobody:\n${list}\n` +
        "Rerun if a gateway or the indexer failed (IPFS_READ_GATEWAYS sets the gateways). An item that cannot be read at all " +
        `is left out only once ${exclusions.path} names it: {"itemID": "<id>", "scope": "${scope}", "reason": "…"}.`
    )
  }
  return leftOut
}
