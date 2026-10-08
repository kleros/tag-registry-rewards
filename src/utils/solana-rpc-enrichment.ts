import { Tag } from "../types"
import { findChainConfig } from "./chains"
import { httpFetch } from "./http"
import {
  checkDeadline,
  chunk,
  envInt,
  errorMessage as message,
  forEachConcurrent,
  isBudgetExceeded,
  settleAll,
  sleep,
} from "./runtime-helpers"
import { SolanaEnrichment, SOLANA_HOLDER_THRESHOLD } from "./solana-common"
import { createSolanaRpcPool, SolanaRpcError, SolanaRpcPool, solanaRpcConfigs } from "./solana-rpc"
import { runSplittableWork, SplittableUnit } from "./split-scheduler"
import { readCacheFile, ThrottledWriter, txCountCacheDir, txCountCacheEnabled } from "./tx-count-cache"

// Solana counts from plain JSON-RPC (works keyless on the public endpoint;
// add Helius/Alchemy URLs to SOLANA_RPC_URLS to go faster). Same definitions
// as the Dune queries this replaces:
// - tx count: successful (err == null) transactions that include the address,
//   all-time. getSignaturesForAddress pages 1,000 signatures at a time, so
//   every signature is paged through and counted here.
// - holders (Tokens registry): distinct owners of the mint's open token
//   accounts, whatever their balance.

export const SOLANA_RPC_DEFINITION =
  "successful signatures (err == null) from getSignaturesForAddress, all-time, finalized"
export const SOLANA_HOLDERS_DEFINITION =
  "distinct owners of the mint's open token accounts, any balance (Jupiter holderCount, which only counts non-zero balances, is accepted when already >= threshold)"

const SOLANA_CHAIN_ID = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]
const JUPITER_DEFAULT_URL = "https://api.jup.ag/tokens/v2/search"
const PAGE_SIZE = 1000
const CACHE_FILE = "solana-rpc.json"
const CACHE_VERSION = 1
const MIN_SPLIT_SLOTS = 20000 // ~2 h of slots
const SLOT_MS = 400
const PROGRESS_LOG_MS = 60000
// A cursor a URL cannot find (-32020) is asked again, on another URL, after a
// pause: lagging nodes and archive indexes cause it too, not only bad cursors.
const CURSOR_ATTEMPTS = 3
const CURSOR_RETRY_MS = 60000
// getBlock errors that mean "no block in this slot" (skipped or not stored).
const EMPTY_SLOT_CODES = [-32007, -32009, -32004]

interface SignatureInfo {
  signature: string
  slot: number
  err: unknown
  blockTime?: number | null
}

// One contiguous slice of an address's history, paged newest to oldest:
// signatures strictly older than `before` (or the newest one) and strictly
// newer than `until` (or the first one).
interface SignatureSegment {
  before?: string
  beforeSlot?: number
  until?: string
  untilSlot?: number
  successful: number
  failed: number
  pages: number
  done: boolean
  top?: boolean
  // The last page was short: an empty answer to the next call, asked of
  // another URL when there is one, ends the segment.
  confirming?: boolean
  // `until` is a split anchor, the last transaction of its block: everything
  // else in that slot belongs to the segment below.
  untilIsAnchor?: boolean
  // `before` is still the split anchor (no page returned yet): an empty
  // answer is only trusted from a URL that knows the anchor.
  beforeIsAnchor?: boolean
}

interface SignatureJob {
  baseSuccessful: number
  baseFailed: number
  previousNewestSig?: string
  previousNewestSlot?: number
  newestSig?: string
  newestSlot?: number
  topSeen: boolean // the top segment has returned a non-empty page
  lowSlotHint?: number
  maxBlockTime?: number // verification only: ignore signatures after this unix time
  pageCap?: number // auto mode: stop listing past this many pages and sample instead
  abandoned?: boolean // stopped at pageCap; its partial counts are discarded
  rangeLo?: number // auto mode: first slot of the listed range (sampled from here if abandoned)
  sampledBase?: boolean // auto mode: tops up a sampled count, so the result is sampled too
  createdAt: string
  segments: SignatureSegment[]
}

interface SignatureEntry {
  successful: number
  failed: number
  newestSig?: string
  newestSlot?: number
  method: "exact" | "estimated" | "sampled"
  updatedAt: string
}

// One window of a stratified sample: [a0, a1) is its stratum, `ranges` the
// slots counted (w of them, wrapping inside the stratum).
interface SampleWindow {
  a0: number
  a1: number
  w: number
  ranges: [number, number][]
  total?: number // exact counts, once the window is done
  ok?: number
}

// A sampled count still running (auto mode), saved so that an interrupted run
// resumes it instead of mapping and counting the range again: its range, the
// count it adds to, the density map and the windows, with those already
// counted. Counts of finalized slot ranges never change, so they stay valid.
interface SampleJob {
  lo: number
  hi: number
  base?: SignatureEntry
  newest: { signature: string; slot: number }
  map?: DensityMap
  windows?: SampleWindow[]
  createdAt: string
}

interface SolanaCache {
  version: number
  definition: string
  entries: { [address: string]: SignatureEntry }
  jobs: { [address: string]: SignatureJob }
  samples: { [address: string]: SampleJob }
}

export interface HolderResult {
  holders: number
  source: "jupiter" | "onchain" | "onchain-partial" | "missing-mint" | "not-a-mint"
  createdAt?: string
}

export interface SolanaRpcAddressReport {
  address: string
  registries: string[]
  method: "exact" | "estimated" | "sampled" | "skipped-holders" | "invalid"
  successful: number
  failed: number
  holders?: number
  holdersSource?: string
}

export interface SolanaRpcEnrichmentResult {
  byKey: { [cacheKey: string]: SolanaEnrichment }
  addresses: SolanaRpcAddressReport[]
  endpoints: string[]
  pages: number
  cacheDir?: string
}

export interface SolanaRpcOptions {
  persist?: boolean
  rpc?: SolanaRpcPool
}

export const isSolanaAddress = (address: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)

// The URL used when SOLANA_RPC_URLS is empty.
export const defaultSolanaRpcUrl = (): string => {
  const chain = findChainConfig(SOLANA_CHAIN_ID)
  return chain ? chain.rpc : "https://api.mainnet-beta.solana.com"
}

export const defaultSolanaRpcPool = (): SolanaRpcPool => createSolanaRpcPool(defaultSolanaRpcUrl())

interface SignatureCursor {
  before?: string
  beforeSlot?: number
  until?: string
}

// Why a page cannot be right for its cursor, or null: slots never rise,
// nothing is newer than `before`, `before` itself is excluded and nothing
// repeats. (No size check: Agave can legitimately return limit + 1.)
const invalidPage = (page: SignatureInfo[], cursor: SignatureCursor): string | null => {
  const seen = new Set<string>()
  let previous = Infinity
  for (const sig of page) {
    if (sig.slot > previous) return "slots out of order"
    if (cursor.beforeSlot !== undefined && sig.slot > cursor.beforeSlot) return "an entry newer than its before cursor"
    if (sig.signature === cursor.before) return "its own before cursor"
    if (seen.has(sig.signature)) return "a duplicate signature"
    seen.add(sig.signature)
    previous = sig.slot
  }
  return null
}

// One page of an address's history, newest first. A page that contradicts its
// cursor is asked again from another URL, and so is a cursor a URL cannot find
// (-32020), after a pause. `avoid` lists URLs to skip when another one is free.
const getSignatures = async (
  rpc: SolanaRpcPool,
  address: string,
  cursor: SignatureCursor,
  avoid: number[] = []
): Promise<{ page: SignatureInfo[]; endpoint?: number }> => {
  const config: { limit: number; commitment: string; before?: string; until?: string } = {
    limit: PAGE_SIZE,
    commitment: "finalized",
  }
  if (cursor.before) config.before = cursor.before
  if (cursor.until) config.until = cursor.until
  const skip = avoid.slice()
  for (let attempt = 1; ; attempt++) {
    const answered: { endpoint?: number } = {}
    let page: SignatureInfo[]
    try {
      page = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [address, config], {
        avoid: skip,
        onAnswer: (endpoint) => {
          answered.endpoint = endpoint
        },
      })
    } catch (err) {
      if (!(err instanceof SolanaRpcError) || err.code !== -32020 || attempt >= CURSOR_ATTEMPTS) throw err
      if (err.endpoint !== undefined) skip.push(err.endpoint)
      console.warn(`[solana] ${address}: ${err.message}; asking again in ${CURSOR_RETRY_MS / 1000} s`)
      await sleep(CURSOR_RETRY_MS)
      continue
    }
    if (!Array.isArray(page)) throw new Error(`getSignaturesForAddress returned ${JSON.stringify(page)}`)
    for (const sig of page) {
      if (!sig || typeof sig.signature !== "string" || typeof sig.slot !== "number" || !("err" in sig)) {
        throw new Error(`unexpected getSignaturesForAddress entry ${JSON.stringify(sig).slice(0, 200)}`)
      }
    }
    const problem = invalidPage(page, cursor)
    if (!problem) return { page, endpoint: answered.endpoint }
    if (attempt >= CURSOR_ATTEMPTS) {
      throw new Error(`getSignaturesForAddress keeps returning ${problem} (before ${cursor.before || "none"})`)
    }
    console.warn(`[solana] ${address}: a URL returned ${problem}; asking another URL`)
    if (answered.endpoint !== undefined) skip.push(answered.endpoint)
  }
}

// Whether one URL can find a transaction anywhere in its history (without
// searchTransactionHistory only the last few hundred slots are searched).
// Any error counts as "cannot".
const knowsSignature = async (rpc: SolanaRpcPool, signature: string, endpoint: number): Promise<boolean> => {
  try {
    const res = await rpc.call<{ value?: unknown[] }>(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
      { only: endpoint, maxAttempts: 3 }
    )
    return !!(res && Array.isArray(res.value) && res.value[0])
  } catch (err) {
    if (err instanceof SolanaRpcError) return false
    throw err
  }
}

// The page right below a split anchor, a `before` cursor that need not involve
// the address. Agave before 4.0 (and possibly other stacks) answers [] for a
// cursor it cannot find instead of -32020, which would end a count early and
// silently: an empty answer only counts once the URL that gave it knows the
// anchor; otherwise every other URL is asked in turn.
const getSignaturesBelowAnchor = async (
  rpc: SolanaRpcPool,
  address: string,
  cursor: SignatureCursor,
  avoid: number[] = []
): Promise<{ page: SignatureInfo[]; endpoint?: number }> => {
  const anchor = cursor.before as string
  const tried = new Set<number>()
  let res = await getSignatures(rpc, address, cursor, avoid)
  for (;;) {
    if (res.page.length > 0 || res.endpoint === undefined) return res
    tried.add(res.endpoint)
    if (await knowsSignature(rpc, anchor, res.endpoint)) return res
    const next = rpc.endpointOrder().filter((i) => !tried.has(i))[0]
    if (next === undefined) {
      throw new Error(
        `no RPC URL can find the split cursor ${anchor} (slot ${cursor.beforeSlot}), so the empty page below it ` +
          "cannot be trusted. Rerun later."
      )
    }
    console.warn(
      `[solana] ${address}: ${rpc.label(res.endpoint)} answered [] below a cursor it cannot find; asking ${rpc.label(next)}`
    )
    tried.add(next)
    res = await getSignatures(rpc, address, cursor, rpc.endpointOrder().filter((i) => i !== next))
  }
}

// Signatures another URL has below a short `page` (below its last signature,
// or below `cursor` when it is empty); [] confirms the page. A short page
// claims the end of a history, and one URL can get that wrong: Agave stops
// short where it cannot go on in long-term storage (a node without one, a
// signature not uploaded yet, any storage error before 2.0.23). As in the exact
// count, one other URL settles it; with `everyUrl`, each one is asked in turn.
const olderElsewhere = async (
  rpc: SolanaRpcPool,
  address: string,
  page: SignatureInfo[],
  endpoint: number | undefined,
  cursor: SignatureCursor,
  everyUrl = false
): Promise<SignatureInfo[]> => {
  const last = page[page.length - 1]
  const below: SignatureCursor = last ? { before: last.signature, beforeSlot: last.slot } : cursor
  const ask = (avoid: number[]) =>
    !last && below.before ? getSignaturesBelowAnchor(rpc, address, below, avoid) : getSignatures(rpc, address, below, avoid)
  const others = rpc.endpointOrder().filter((i) => i !== endpoint)
  // Alone, a URL that answered [] would only be asked the same question again.
  if (others.length === 0) return last || everyUrl ? (await ask([])).page : []
  if (!everyUrl) return (await ask(endpoint !== undefined ? [endpoint] : [])).page
  for (const other of others) {
    const { page: older } = await ask(rpc.endpointOrder().filter((i) => i !== other))
    if (older.length > 0) return older
  }
  return []
}

// The address's newest page and whether it holds everything (since
// `sinceSlot`, the newest slot of a cached count, when there is one), which a
// short or empty page claims and another URL confirms (see olderElsewhere).
const getNewestPage = async (
  rpc: SolanaRpcPool,
  address: string,
  sinceSlot?: number
): Promise<{ page: SignatureInfo[]; complete: boolean }> => {
  const first = await getSignatures(rpc, address, {})
  const page = first.page
  if (page.length >= PAGE_SIZE) return { page, complete: false }
  if (sinceSlot !== undefined && page.some((sig) => sig.slot <= sinceSlot)) return { page, complete: true }
  // A cached count proves older signatures exist: every URL is asked before giving up.
  const older = await olderElsewhere(rpc, address, page, first.endpoint, {}, sinceSlot !== undefined)
  if (older.length > 0) {
    console.warn(`[solana] ${address}: a URL's newest page stopped short; another URL has older signatures`)
    // After an empty first answer, `older` is the newest page itself.
    return { page: page.length > 0 ? page : older, complete: false }
  }
  if (sinceSlot !== undefined) {
    throw new Error(
      `[solana] ${address}: no RPC URL returns signatures down to slot ${sinceSlot}, where the cached count has one. ` +
        `Rerun later; if it persists, remove "${address}" from "entries" in ${txCountCacheDir()}/${CACHE_FILE} to recount it.`
    )
  }
  return { page, complete: true }
}

// The last transaction of the first non-empty block in [fromSlot, limitSlot).
// Used as a `before`/`until` cursor to split an address's history: cursors do
// not have to involve the address itself.
export const findAnchor = async (
  rpc: SolanaRpcPool,
  fromSlot: number,
  limitSlot: number,
  stats?: { calls: number } // counts the getBlock calls made
): Promise<{ signature: string; slot: number } | null> => {
  for (let slot = Math.max(1, fromSlot), tries = 0; slot < limitSlot && tries < 50; slot++, tries++) {
    if (stats) stats.calls++
    try {
      const block = await rpc.call<{ signatures?: string[] } | null>("getBlock", [
        slot,
        {
          encoding: "json",
          transactionDetails: "signatures",
          rewards: false,
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ])
      if (block && block.signatures && block.signatures.length > 0) {
        return { signature: block.signatures[block.signatures.length - 1], slot }
      }
    } catch (err) {
      if (err instanceof SolanaRpcError && err.code !== undefined && EMPTY_SLOT_CODES.includes(err.code)) continue
      throw err
    }
  }
  return null
}

// A block at or above `slot` (below `limitSlot`), searching further and further
// up when no URL has a block in the first slots (skipped, or a stretch missing
// from long-term storage): any cursor above a range works, it only costs the
// pages between it and the range. Null when none is found.
const findAnchorAbove = async (
  rpc: SolanaRpcPool,
  slot: number,
  limitSlot: number,
  stats?: { calls: number }
): Promise<{ signature: string; slot: number } | null> => {
  const near = await findAnchor(rpc, slot, Math.min(limitSlot, slot + 400), stats)
  if (near) return near
  for (let step = 250; slot + step < limitSlot; step *= 4) {
    const anchor = await findAnchor(rpc, slot + step, Math.min(limitSlot, slot + step + 10), stats)
    if (anchor) return anchor
  }
  return null
}

// ---------------------------------------------------------------------------
// Holders

const fetchJupiterTokens = async (
  mints: string[]
): Promise<{ [mint: string]: { holderCount?: number; createdAt?: string; tokenProgram?: string } }> => {
  const url = (process.env.JUPITER_TOKENS_API_URL || JUPITER_DEFAULT_URL).trim()
  const apiKey = String(process.env.JUPITER_API_KEY || "").trim()
  const headers: { [h: string]: string } = { Accept: "application/json" }
  if (apiKey) headers["x-api-key"] = apiKey
  // Keyless is 0.5 req/s on a 60 s sliding window, a free key 1 req/s.
  const spacingMs = apiKey ? 1100 : 2100
  const out: { [mint: string]: { holderCount?: number; createdAt?: string; tokenProgram?: string } } = {}
  const parts = chunk(mints, 100) // the endpoint silently truncates above 100
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(spacingMs)
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await httpFetch(`${url}?query=${parts[i].join(",")}`, { headers, timeout: 30000 })
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const body = await res.json()
        if (!Array.isArray(body)) throw new Error("unexpected response shape")
        for (const token of body) {
          if (!token || typeof token.id !== "string") continue
          out[token.id] = {
            holderCount: typeof token.holderCount === "number" ? token.holderCount : undefined,
            createdAt: token.createdAt || (token.firstPool && token.firstPool.createdAt) || undefined,
            tokenProgram: typeof token.tokenProgram === "string" ? token.tokenProgram : undefined,
          }
        }
        break
      } catch (err) {
        if (attempt >= 4) {
          console.warn(`[solana-holders] Jupiter lookup failed (${message(err)}); checking these mints on-chain instead`)
          break
        }
        await sleep(3000 * attempt)
      }
    }
  }
  return out
}

const getOwnerPrograms = async (rpc: SolanaRpcPool, mints: string[]): Promise<{ [mint: string]: string | null }> => {
  const out: { [mint: string]: string | null } = {}
  for (const part of chunk(mints, 100)) {
    const res = await rpc.call<{ value?: ({ owner?: string } | null)[] }>("getMultipleAccounts", [
      part,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
    ])
    if (!res || !Array.isArray(res.value) || res.value.length !== part.length) {
      throw new Error(`[solana-holders] unexpected getMultipleAccounts response`)
    }
    part.forEach((mint, i) => {
      const account = res.value ? res.value[i] : null
      out[mint] = account && account.owner ? account.owner : null
    })
  }
  return out
}

// Both program constants must be executable accounts on-chain: a typo in one
// would otherwise drop all of that program's mints as "not a mint".
const assertTokenProgramsExist = async (rpc: SolanaRpcPool): Promise<void> => {
  const res = await rpc.call<{ value?: ({ executable?: boolean } | null)[] }>("getMultipleAccounts", [
    TOKEN_PROGRAMS,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
  ])
  const missing = TOKEN_PROGRAMS.filter((_, i) => {
    const account = res && Array.isArray(res.value) ? res.value[i] : null
    return !(account && account.executable)
  })
  if (missing.length > 0) {
    throw new Error(`[solana-holders] token program constant(s) ${missing.join(", ")} are not executable accounts on-chain`)
  }
}

// Too large for one call: count owners in buckets. Not -32010, which is a
// node's index configuration (buckets go through the same index).
const isTooBig = (err: unknown): boolean =>
  err instanceof SolanaRpcError &&
  (err.kind === "too-large" || err.kind === "timeout" || err.code === -32012 || err.httpStatus === 413)

// Holder scans go to one URL at a time, the public RPC first: it is the only
// endpoint verified for these filters, and providers refuse them in their own
// ways (-32010 index exclusions, Helius's "use getProgramAccountsV2", HTTP
// 500). Any refusal that is not about size moves on to the next URL.
const fetchOwners = async (rpc: SolanaRpcPool, program: string, filters: unknown[]): Promise<string[]> => {
  let lastError: unknown = null
  for (const endpoint of rpc.endpointOrder(true)) {
    const call = (f: unknown[]) =>
      rpc.call<{ account: { data: [string, string] } }[]>(
        "getProgramAccounts",
        [program, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 32, length: 32 }, filters: f }],
        { timeoutMs: 180000, maxBytes: 500 * 1024 * 1024, failFastOnTimeout: true, only: endpoint, maxAttempts: 3 }
      )
    try {
      let accounts: { account: { data: [string, string] } }[]
      try {
        accounts = await call(filters)
      } catch (err) {
        // Some providers may not know the tokenAccountState filter; the mint
        // memcmp alone selects the same accounts (verified on mainnet).
        if (err instanceof SolanaRpcError && err.code === -32602 && filters.includes("tokenAccountState")) {
          accounts = await call(filters.filter((f) => f !== "tokenAccountState"))
        } else {
          throw err
        }
      }
      if (!Array.isArray(accounts)) throw new Error("[solana-holders] unexpected getProgramAccounts response")
      return accounts.map((a) => a.account.data[0])
    } catch (err) {
      if (isTooBig(err) || !(err instanceof SolanaRpcError)) throw err
      lastError = err
      console.warn(`[solana-holders] ${rpc.label(endpoint)} did not serve getProgramAccounts (${message(err)}); trying the next URL`)
    }
  }
  throw lastError || new Error("[solana-holders] no RPC URL served getProgramAccounts")
}

// Distinct owners of the mint's open token accounts (no balance filter, like
// Dune). Very large mints are counted by owner byte, stopping once `stopAt` is
// reached: only the threshold matters for them.
export const countDistinctOwners = async (
  rpc: SolanaRpcPool,
  mint: string,
  program: string,
  stopAt: number
): Promise<{ owners: number; complete: boolean }> => {
  const filters: unknown[] =
    program === TOKEN_PROGRAM
      ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]
      : [{ memcmp: { offset: 0, bytes: mint } }, "tokenAccountState"]
  try {
    const owners = await fetchOwners(rpc, program, filters)
    return { owners: new Set(owners).size, complete: true }
  } catch (err) {
    if (!isTooBig(err)) throw err
    console.warn(`[solana-holders] ${mint}: too many accounts for one scan, counting owners in buckets`)
  }
  let total = 0
  for (let b = 0; b < 256; b++) {
    // Buckets by the owner's last byte (offset 63): Agave 3.1+ rejects any
    // memcmp at offset 32 that is not a whole 32-byte owner.
    const bucket = filters.concat([
      { memcmp: { offset: 63, bytes: Buffer.from([b]).toString("base64"), encoding: "base64" } },
    ])
    total += new Set(await fetchOwners(rpc, program, bucket)).size
    if (total >= stopAt) return { owners: total, complete: false }
  }
  return { owners: total, complete: true }
}

export const checkHolders = async (
  rpc: SolanaRpcPool,
  mints: string[],
  threshold = SOLANA_HOLDER_THRESHOLD
): Promise<{ [mint: string]: HolderResult }> => {
  const out: { [mint: string]: HolderResult } = {}
  const jupiter = await fetchJupiterTokens(mints)
  // A wrong program constant would drop every mint of that program as "not a
  // mint": Jupiter's tokenProgram for each mint it knows must be one of them.
  const unknownPrograms = mints.filter((mint) => {
    const program = jupiter[mint] ? jupiter[mint].tokenProgram : undefined
    return program !== undefined && TOKEN_PROGRAMS.indexOf(program) < 0
  })
  if (unknownPrograms.length > 0) {
    throw new Error(
      "[solana-holders] Jupiter reports token programs this code does not know: " +
        unknownPrograms.map((mint) => `${mint} -> ${jupiter[mint].tokenProgram}`).join(", ") +
        ". Check TOKEN_PROGRAM and TOKEN_2022_PROGRAM in solana-rpc-enrichment.ts."
    )
  }
  const onchain: string[] = []
  for (const mint of mints) {
    const info = jupiter[mint]
    if (info && info.holderCount !== undefined && info.holderCount >= threshold) {
      out[mint] = { holders: info.holderCount, source: "jupiter", createdAt: info.createdAt }
    } else {
      onchain.push(mint)
    }
  }
  if (onchain.length > 0) {
    await assertTokenProgramsExist(rpc)
    const programs = await getOwnerPrograms(rpc, onchain)
    for (const mint of onchain) {
      const createdAt = jupiter[mint] ? jupiter[mint].createdAt : undefined
      const program = programs[mint]
      if (!program) {
        console.warn(`[solana-holders] Mint ${mint} does not exist on-chain: 0 holders`)
        out[mint] = { holders: 0, source: "missing-mint", createdAt }
        continue
      }
      if (TOKEN_PROGRAMS.indexOf(program) < 0) {
        // A wallet, program or pool registered as a token has no token
        // accounts: 0 holders, as Dune counted it, and recorded as such.
        console.warn(`[solana-holders] ${mint} is owned by ${program}, not by an SPL token program: not a token mint, 0 holders`)
        out[mint] = { holders: 0, source: "not-a-mint", createdAt }
        continue
      }
      const { owners, complete } = await countDistinctOwners(rpc, mint, program, threshold)
      out[mint] = { holders: owners, source: complete ? "onchain" : "onchain-partial", createdAt }
    }
  }
  const failing = mints.filter((m) => out[m].holders < threshold).length
  console.log(
    `[solana-holders] ${mints.length} mint(s): ${mints.length - onchain.length} passed on Jupiter's holder count, ` +
      `${onchain.length} checked on-chain, ${failing} below ${threshold} holders`
  )
  return out
}

// ---------------------------------------------------------------------------
// Exact signature counts

class SignatureUnit implements SplittableUnit {
  busy = false
  splitRequested = false
  requests = 0
  density = 0 // signatures per slot on the last full page
  lastEndpoint?: number // URL that served the last page

  constructor(readonly address: string, readonly job: SignatureJob, readonly segment: SignatureSegment) {}

  isDone(): boolean {
    return this.segment.done
  }

  remainingWork(): number {
    const { segment } = this
    if (segment.confirming || !this.requests || !this.density || segment.beforeSlot === undefined) return 0
    const low = segment.untilSlot !== undefined ? segment.untilSlot : this.job.lowSlotHint || 0
    const slots = segment.beforeSlot - low
    if (slots < 2 * MIN_SPLIT_SLOTS) return 0
    return (slots * this.density) / PAGE_SIZE
  }
}

const newJob = (entry: SignatureEntry | undefined, lowSlotHint?: number, maxBlockTime?: number): SignatureJob => {
  const incremental = entry && entry.method === "exact" && entry.newestSig ? entry : undefined
  return {
    baseSuccessful: incremental ? incremental.successful : 0,
    baseFailed: incremental ? incremental.failed : 0,
    previousNewestSig: incremental ? incremental.newestSig : undefined,
    previousNewestSlot: incremental ? incremental.newestSlot : undefined,
    topSeen: false,
    lowSlotHint: incremental ? incremental.newestSlot : lowSlotHint,
    ...(maxBlockTime !== undefined ? { maxBlockTime } : {}),
    createdAt: new Date().toISOString(),
    segments: [
      {
        top: true,
        until: incremental ? incremental.newestSig : undefined,
        untilSlot: incremental ? incremental.newestSlot : undefined,
        successful: 0,
        failed: 0,
        pages: 0,
        done: false,
      },
    ],
  }
}

// The newest signature a job's count covers: the newest it saw, or else the
// one its base count ended at.
const jobNewest = (job: SignatureJob): { signature?: string; slot?: number } =>
  job.newestSig ? { signature: job.newestSig, slot: job.newestSlot } : { signature: job.previousNewestSig, slot: job.previousNewestSlot }

const finishJob = (address: string, job: SignatureJob): SignatureEntry => {
  let successful = 0
  let failed = 0
  for (const segment of job.segments) {
    if (!segment.done) throw new Error(`[solana] internal error: ${address} merged an unfinished count`)
    successful += segment.successful
    failed += segment.failed
  }
  return {
    successful: job.baseSuccessful + successful,
    failed: job.baseFailed + failed,
    newestSig: jobNewest(job).signature,
    newestSlot: jobNewest(job).slot,
    method: job.sampledBase ? "sampled" : "exact",
    updatedAt: new Date().toISOString(),
  }
}

// A job saved by an interrupted run stops at that run's newest signature. A
// new newest segment brings it to the current tip like every other address
// (the EVM lane re-pins after a crash for the same reason).
const topUpResumedJob = (job: SignatureJob): boolean => {
  const top = job.segments.filter((segment) => segment.top)[0]
  if (!top || top.pages === 0) return false // its first page is still ahead: nothing is stale
  top.top = false
  // Never past an empty first page: nothing counted, and the new segment covers its range.
  if (!top.done && top.before === undefined) top.done = true
  const fromNewest = !!job.newestSig
  job.segments.push({
    top: true,
    until: fromNewest ? job.newestSig : job.previousNewestSig,
    untilSlot: fromNewest ? job.newestSlot : job.previousNewestSlot,
    successful: 0,
    failed: 0,
    pages: 0,
    done: false,
  })
  job.topSeen = false
  return true
}

// Pages every open segment of every job to the end, splitting long histories
// across workers. Returns the number of pages fetched.
export const runSignatureJobs = async (
  rpc: SolanaRpcPool,
  jobs: { [address: string]: SignatureJob },
  save: () => void
): Promise<number> => {
  const units: SignatureUnit[] = []
  for (const address of Object.keys(jobs)) {
    for (const segment of jobs[address].segments) {
      if (!segment.done) units.push(new SignatureUnit(address, jobs[address], segment))
    }
  }
  if (units.length === 0) return 0
  const started = Date.now()
  let pages = 0
  let signatures = 0

  const step = async (unit: SignatureUnit): Promise<void> => {
    checkDeadline()
    const { address, job, segment } = unit
    // A history that turned out larger than its sizing said is abandoned here
    // and sampled instead (auto mode).
    if (job.pageCap !== undefined && (job.abandoned || job.segments.reduce((n, s) => n + s.pages, 0) >= job.pageCap)) {
      job.abandoned = true
      for (const s of job.segments) s.done = true
      save()
      return
    }
    let page: SignatureInfo[]
    let endpoint: number | undefined
    try {
      // The call that should confirm the end goes to another URL when there is one.
      const avoid = segment.confirming && unit.lastEndpoint !== undefined ? [unit.lastEndpoint] : []
      const cursor = { before: segment.before, beforeSlot: segment.beforeSlot, until: segment.until }
      const res = segment.beforeIsAnchor
        ? await getSignaturesBelowAnchor(rpc, address, cursor, avoid)
        : await getSignatures(rpc, address, cursor, avoid)
      page = res.page
      endpoint = res.endpoint
    } catch (err) {
      if (err instanceof SolanaRpcError && err.code === -32020) {
        throw new Error(
          `[solana] ${address}: no RPC URL can find a stored cursor signature (code -32020, ${CURSOR_ATTEMPTS} tries). ` +
            `Rerun later; if it persists, remove "${address}" from "jobs" and "entries" in ${txCountCacheDir()}/${CACHE_FILE} to recount it.`
        )
      }
      throw new Error(`[solana] ${address}: ${message(err)}`)
    }
    unit.lastEndpoint = endpoint
    let reachedUntil = false
    let counted = 0
    for (const sig of page) {
      // `until` is exclusive; the slot checks only guard providers that ignore it.
      const untilSlot = segment.untilSlot
      const belowUntil =
        untilSlot !== undefined && (sig.slot < untilSlot || (segment.untilIsAnchor === true && sig.slot === untilSlot))
      if (segment.until && (sig.signature === segment.until || belowUntil)) {
        reachedUntil = true
        break
      }
      if (job.maxBlockTime !== undefined && (sig.blockTime || 0) > job.maxBlockTime) continue
      if (sig.err === null) segment.successful++
      else segment.failed++
      counted++
    }
    if (segment.top && !job.topSeen && page.length > 0) {
      job.topSeen = true
      const newest = page[0]
      if (newest.signature !== segment.until) {
        job.newestSig = newest.signature
        job.newestSlot = newest.slot
      }
    }
    segment.pages++
    unit.requests++
    pages++
    signatures += counted
    // A short page only claims the end of the history: the segment ends on an
    // empty answer, asked of another URL when there is one (Agave can answer
    // short while older history exists, and the providers run other archives).
    if (reachedUntil || (page.length === 0 && segment.confirming)) {
      segment.done = true
    } else {
      if (page.length > 0) {
        const last = page[page.length - 1]
        segment.before = last.signature
        segment.beforeSlot = last.slot
        delete segment.beforeIsAnchor // the cursor is now one of the address's own signatures
        if (page.length >= PAGE_SIZE) unit.density = PAGE_SIZE / Math.max(1, page[0].slot - last.slot + 1)
      }
      segment.confirming = page.length < PAGE_SIZE
    }
    save()
  }

  // Splits [until, before) at a block in the middle of the slot range. The
  // anchor transaction itself falls in neither half; it only matters if it
  // involves the address, which costs at most one signature per split.
  const split = async (unit: SignatureUnit): Promise<SignatureUnit | null> => {
    const { segment, job } = unit
    if (segment.done || segment.confirming || segment.beforeSlot === undefined) return null
    const low = segment.untilSlot !== undefined ? segment.untilSlot : job.lowSlotHint || 0
    const high = segment.beforeSlot
    if (high - low < 2 * MIN_SPLIT_SLOTS) return null
    const anchor = await findAnchor(rpc, Math.floor((low + high) / 2), high)
    if (!anchor) return null
    const lower: SignatureSegment = {
      before: anchor.signature,
      beforeSlot: anchor.slot,
      beforeIsAnchor: true,
      until: segment.until,
      untilSlot: segment.untilSlot,
      ...(segment.untilIsAnchor ? { untilIsAnchor: true } : {}),
      successful: 0,
      failed: 0,
      pages: 0,
      done: false,
    }
    segment.until = anchor.signature
    segment.untilSlot = anchor.slot
    segment.untilIsAnchor = true
    job.segments.push(lower)
    save()
    return new SignatureUnit(unit.address, job, lower)
  }

  const log = () => {
    const open = units.filter((u) => !u.isDone()).length
    const elapsed = Math.max(1, (Date.now() - started) / 1000)
    const endpoints = rpc
      .stats()
      .map((s) => `${s.label} ${s.calls} calls/${s.rateLimited} 429s/${s.errors} errors @${s.rps}/s${s.disabled ? ` (disabled: ${s.disabled})` : ""}`)
      .join("; ")
    console.log(
      `[solana] ${pages} pages (${(pages / elapsed).toFixed(2)}/s), ${signatures} signatures counted, ` +
        `${open} open segment(s) — ${endpoints}`
    )
  }
  const timer = setInterval(log, PROGRESS_LOG_MS)
  try {
    await runSplittableWork(units, rpc.capacity(), step, split)
  } finally {
    clearInterval(timer)
    log()
  }
  return pages
}

// Exact count of one address, without the cache (verification).
export const countSignaturesExact = async (
  rpc: SolanaRpcPool,
  address: string,
  opts: { maxBlockTime?: number; lowSlotHint?: number } = {}
): Promise<{ successful: number; failed: number; pages: number }> => {
  const job = newJob(undefined, opts.lowSlotHint, opts.maxBlockTime)
  const pages = await runSignatureJobs(rpc, { [address]: job }, () => undefined)
  const entry = finishJob(address, job)
  return { successful: entry.successful, failed: entry.failed, pages }
}

// ---------------------------------------------------------------------------
// Estimate for huge addresses outside the Tokens registry (e.g. Jupiter's
// program, billions of signatures): samples the density of the history at
// evenly spaced blocks and integrates it. Within ~10% on programs with smooth
// activity; NOT used for Tokens-registry mints, whose bursty activity it
// misjudges (a mint listed in another registry is logged when estimated).

interface Estimate {
  successful: number
  failed: number
  newestSig?: string
  newestSlot?: number
  exact: boolean
  // Stopped early: clearly below `smallBelow`, page it exactly instead.
  small?: boolean
  calls: number
}

export const estimateSignatures = async (
  rpc: SolanaRpcPool,
  address: string,
  probes: number,
  smallBelow?: number
): Promise<Estimate> => {
  const successfulIn = (page: SignatureInfo[]) => page.filter((s) => s.err === null).length
  const { page: tipPage } = await getSignatures(rpc, address, {})
  const newest = tipPage[0]
  if (tipPage.length < PAGE_SIZE) {
    const ok = successfulIn(tipPage)
    return {
      successful: ok,
      failed: tipPage.length - ok,
      newestSig: newest ? newest.signature : undefined,
      newestSlot: newest ? newest.slot : undefined,
      exact: true,
      calls: 1,
    }
  }
  const tip = newest.slot
  let calls = 1
  const points: { slot: number; density: number; okRatio: number }[] = []
  const addPoint = (slot: number, page: SignatureInfo[]) => {
    const span = Math.max(1, slot - page[page.length - 1].slot + 1)
    points.push({ slot, density: page.length / span, okRatio: successfulIn(page) / page.length })
  }
  addPoint(tip, tipPage)
  const probe = async (target: number) => {
    const anchor = await findAnchor(rpc, target, tip)
    if (!anchor) return null
    const { page } = await getSignaturesBelowAnchor(rpc, address, { before: anchor.signature, beforeSlot: anchor.slot })
    calls += 2
    return { slot: anchor.slot, page }
  }

  // Find where the history starts: probe further and further back until a
  // page comes back short (everything at or below that block is then known).
  let low = 0
  let lowSuccessful = 0
  let lowFailed = 0
  for (let j = 0; ; j++) {
    const target = Math.max(1, tip - 4096 * Math.pow(4, j))
    const p = await probe(target)
    if (p && p.page.length < PAGE_SIZE) {
      low = p.slot
      lowSuccessful = successfulIn(p.page)
      lowFailed = p.page.length - lowSuccessful
      break
    }
    if (p) addPoint(p.slot, p.page)
    if (target === 1) break
  }
  // Generous upper bound (twice the densest sample over the whole span): when
  // even that is below `smallBelow`, the caller pages exactly and the probes
  // below would be wasted.
  if (smallBelow !== undefined) {
    const densest = Math.max(...points.map((p) => p.density))
    const upper = lowSuccessful + lowFailed + 2 * densest * (tip - low)
    if (upper <= smallBelow) {
      return { successful: 0, failed: 0, exact: false, small: true, calls }
    }
  }
  for (let i = 1; i <= probes; i++) {
    const p = await probe(Math.floor(low + ((tip - low) * i) / (probes + 1)))
    if (p && p.page.length === PAGE_SIZE) addPoint(p.slot, p.page)
  }

  const sorted = points.filter((p) => p.slot > low).sort((a, b) => a.slot - b.slot)
  let total = 0
  let successful = 0
  let prev = { slot: low, density: sorted[0].density, okRatio: sorted[0].okRatio }
  for (const point of sorted) {
    const width = point.slot - prev.slot
    total += (width * (prev.density + point.density)) / 2
    successful += (width * (prev.density * prev.okRatio + point.density * point.okRatio)) / 2
    prev = point
  }
  return {
    successful: Math.round(lowSuccessful + successful),
    failed: Math.round(lowFailed + total - successful),
    newestSig: newest.signature,
    newestSlot: tip,
    exact: false,
    calls,
  }
}

// ---------------------------------------------------------------------------
// Sampled counts (SOLANA_COUNT_MODE=auto, the default)
//
// Listing every signature costs one call per 1,000, and free and small paid
// keys sustain ~5–10 calls/s together, so a month counted from scratch
// (September 2026: ~740M signatures) takes about a day and a half. Ranges
// whose size can exceed SOLANA_EXACT_BELOW signatures are estimated instead by
// stratified sampling: a first pass maps the density of the range (one page
// below each of SOLANA_SAMPLE_POINTS evenly spaced slots), the range is cut
// into SOLANA_SAMPLE_STRATA strata of equal mapped mass, and in each stratum
// one window sized to hold ~SOLANA_SAMPLE_WINDOW signatures, placed uniformly
// at random and wrapping inside its stratum (so every slot has the same
// chance), is counted exactly. A stratum contributes length / window × count,
// which is unbiased whatever the map's quality; the map only spends the
// windows where the signatures are. Replayed on three complete September 2026
// histories (2.5M–9.6M signatures) the defaults gave a 7–17% typical error per
// mint and no bias, for ~1,000–1,500 calls instead of 2,500–9,600 (live runs
// used ~1,500–2,500 per sampled mint).

export const getSolanaCountMode = (): "exact" | "auto" => {
  const raw = String(process.env.SOLANA_COUNT_MODE || "auto").trim().toLowerCase()
  if (raw === "exact" || raw === "auto") return raw
  throw new Error(`Invalid SOLANA_COUNT_MODE="${raw}": expected "auto" or "exact"`)
}

// Ranges are sized by a quick map first (every 10th point of the full one,
// ~40 calls instead of ~400): one it puts at or below a quarter of
// SOLANA_EXACT_BELOW is listed right away. Replayed on 509 ranges (1 day to
// the whole history) of three complete September 2026 histories, the quick
// map listed 411 of them early, the largest of those held 941k signatures (far
// below the page cap), and none would have been sampled with the full map.
const QUICK_MAP_POINTS = 20
const QUICK_LIST_MARGIN = 4

const sampleSettings = () => ({
  exactBelow: envInt("SOLANA_EXACT_BELOW", 1500000),
  points: envInt("SOLANA_SAMPLE_POINTS", 200) || 200,
  strata: envInt("SOLANA_SAMPLE_STRATA", 150) || 150,
  window: envInt("SOLANA_SAMPLE_WINDOW", 5000) || 5000,
})

// Deterministic (mulberry32 seeded by a string hash), so a rerun over the same
// range draws the same windows and gives the same estimate.
const seededRandom = (seed: string): (() => number) => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface RangeCount {
  total: number
  ok: number
  calls: number
}

// The address's signatures with lo <= slot < hi, counted exactly: pages down
// from the first block at or above `hi` (or from the newest signature when
// `hi` is past the tip). A short page claims the start of the history and is
// confirmed once on another URL, as in the exact count.
const countSlotRange = async (
  rpc: SolanaRpcPool,
  address: string,
  lo: number,
  hi: number,
  tipSlot: number
): Promise<RangeCount> => {
  let calls = 0
  let cursor: SignatureCursor = {}
  let anchored = false
  if (hi <= tipSlot) {
    const search = { calls: 0 }
    let anchor = await findAnchorAbove(rpc, hi, tipSlot + 1, search)
    // Blocks exist up to the tip (the finalized slot has one), so none found
    // means getBlock is failing (or a URL lagging behind the tip answered for
    // all of them): ask again once, then stop. Paging down from the newest
    // signature instead could take millions of calls deep in a long history.
    if (!anchor) {
      await sleep(10000)
      anchor = await findAnchorAbove(rpc, hi, tipSlot + 1, search)
    }
    calls += search.calls
    if (!anchor) throw new Error(`[solana] no RPC URL returned a block between slot ${hi} and the tip (${tipSlot}); rerun later`)
    cursor = { before: anchor.signature, beforeSlot: anchor.slot }
    anchored = true
  }
  let total = 0
  let ok = 0
  let confirming = false
  let avoid: number[] = []
  for (;;) {
    checkDeadline()
    const res = anchored
      ? await getSignaturesBelowAnchor(rpc, address, cursor, avoid)
      : await getSignatures(rpc, address, cursor, avoid)
    calls++
    const page = res.page
    let below = false
    for (const sig of page) {
      if (sig.slot >= hi) continue
      if (sig.slot < lo) {
        below = true
        break
      }
      total++
      if (sig.err === null) ok++
    }
    if (below) break
    if (page.length < PAGE_SIZE) {
      if (confirming || res.endpoint === undefined || rpc.labels().length < 2) break
      confirming = true
      avoid = [res.endpoint]
    } else {
      confirming = false
      avoid = []
    }
    if (page.length > 0) {
      const last = page[page.length - 1]
      cursor = { before: last.signature, beforeSlot: last.slot }
      anchored = false // the cursor is now one of the address's own signatures
    }
  }
  return { total, ok, calls }
}

// Signatures per slot just below `x`, within [lo, x): one page.
const densityBelow = async (
  rpc: SolanaRpcPool,
  address: string,
  lo: number,
  x: number,
  tipSlot: number
): Promise<{ density: number; calls: number }> => {
  let calls = 0
  let cursor: SignatureCursor = {}
  let anchored = false
  if (x <= tipSlot) {
    // Only a nearby block: from far above, the 4 pages below would not reach x.
    const anchor = await findAnchor(rpc, x, x + 400)
    calls++
    if (!anchor) return { density: 0, calls }
    cursor = { before: anchor.signature, beforeSlot: anchor.slot }
    anchored = true
  }
  // a burst between x and the anchor's block can fill whole pages: skip them
  for (let i = 0; i < 4; i++) {
    checkDeadline()
    const res = anchored ? await getSignaturesBelowAnchor(rpc, address, cursor) : await getSignatures(rpc, address, cursor)
    calls++
    const inRange = res.page.filter((s) => s.slot < x && s.slot >= lo)
    const crossed = res.page.some((s) => s.slot < lo)
    if (inRange.length > 0 || crossed || res.page.length < PAGE_SIZE) {
      if (res.page.length < PAGE_SIZE || crossed) return { density: inRange.length / Math.max(1, x - lo), calls }
      const oldest = inRange[inRange.length - 1].slot
      return { density: inRange.length / Math.max(1, x - oldest + 1), calls }
    }
    const last = res.page[res.page.length - 1]
    cursor = { before: last.signature, beforeSlot: last.slot }
    anchored = false
  }
  return { density: 0, calls }
}

// Lowest slot the address has a signature at (approximately: within ~0.1% of
// its lifetime), searched back from the tip; `hint` (e.g. Jupiter's creation
// date as a slot) narrows the search.
export const findHistoryStart = async (
  rpc: SolanaRpcPool,
  address: string,
  tipSlot: number,
  hint?: number
): Promise<{ start: number; calls: number }> => {
  let calls = 0
  // probe(x): "none" = no history below x, "short" = all of it in one page, "more" = more than a page
  const probe = async (x: number): Promise<{ state: "none" | "short" | "more"; oldest?: number }> => {
    const anchor = await findAnchor(rpc, x, x + 400)
    calls++
    if (!anchor) return { state: "more" }
    const cursor = { before: anchor.signature, beforeSlot: anchor.slot }
    const res = await getSignaturesBelowAnchor(rpc, address, cursor)
    calls++
    if (res.page.length >= PAGE_SIZE) return { state: "more" }
    // "none" and "short" place the start of the history, and a cached count
    // keeps a start placed too late forever: another URL confirms them.
    const older = await olderElsewhere(rpc, address, res.page, res.endpoint, cursor)
    calls++
    if (older.length > 0) return { state: "more" }
    const last = res.page[res.page.length - 1]
    return last ? { state: "short", oldest: last.slot } : { state: "none" }
  }
  let hi = tipSlot // history exists below hi
  let lo = 0 // no history below lo
  const candidates: number[] = []
  if (hint !== undefined && hint > 0 && hint < tipSlot) candidates.push(Math.max(1, Math.floor(hint - (tipSlot - hint) * 0.2)))
  for (let j = 0; ; j++) {
    const t = tipSlot - 4096 * Math.pow(4, j)
    if (t <= 1) break
    candidates.push(t)
  }
  for (const t of candidates) {
    if (t >= hi) continue
    const r = await probe(t)
    if (r.state === "short") return { start: r.oldest as number, calls }
    if (r.state === "none") {
      lo = t
      break
    }
    hi = t
  }
  // binary search the boundary between "none" and "more"
  while (hi - lo > Math.max(2000, (tipSlot - hi) / 1000)) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await probe(mid)
    if (r.state === "short") return { start: r.oldest as number, calls }
    if (r.state === "none") lo = mid
    else hi = mid
  }
  return { start: lo, calls }
}

export interface DensityMap {
  lo: number
  hi: number
  cell: number
  density: number[] // signatures per slot below the middle of each cell (NaN: not measured yet)
  size: number // rough size of the range (it decides listing vs sampling, not the count)
  calls: number
}

const isComplete = (map: DensityMap): boolean => map.density.every((d) => !isNaN(d))

// First pass of the sampler: the density below SOLANA_SAMPLE_POINTS evenly
// spaced slots of [lo, hi). With `stride` > 1 only every stride-th point is
// measured (a quick sizing); `prior`, a partial map of the same range, keeps
// its points and only the missing ones are measured.
export const mapRange = async (
  rpc: SolanaRpcPool,
  address: string,
  lo: number,
  hi: number,
  tipSlot: number,
  stride = 1,
  prior?: DensityMap
): Promise<DensityMap> => {
  const span = hi - lo
  const P = Math.max(2, Math.min(sampleSettings().points, span))
  const cell = span / P
  const reused = prior && prior.lo === lo && prior.hi === hi && prior.density.length === P ? prior : undefined
  let calls = reused ? reused.calls : 0
  const density: number[] = reused ? reused.density.slice() : new Array(P).fill(NaN)
  const todo = Array.from({ length: P }, (_, i) => i).filter(
    (i) => isNaN(density[i]) && (stride <= 1 || i % stride === Math.floor(stride / 2))
  )
  await forEachConcurrent(todo, 8, async (i) => {
    const x = Math.min(hi, Math.floor(lo + (i + 0.5) * cell) + 1)
    const r = await densityBelow(rpc, address, lo, x, tipSlot)
    calls += r.calls
    density[i] = r.density
  })
  const measured = density.filter((d) => !isNaN(d))
  const size = measured.length > 0 ? (measured.reduce((sum, d) => sum + d, 0) / measured.length) * span : 0
  return { lo, hi, cell, density, size, calls }
}

// The windows of a stratified sample of [lo, hi) (see above), one per stratum
// of equal mapped mass. Drawn from a PRNG seeded by the range, so the same
// range and map always give the same windows.
const drawWindows = (address: string, lo: number, hi: number, map: DensityMap): SampleWindow[] => {
  const settings = sampleSettings()
  const { density, cell } = map
  const P = density.length
  const maxDensity = Math.max(...density)
  const floor = maxDensity > 0 ? maxDensity * 1e-4 : 1e-9
  const mass = density.map((d) => Math.max(d, floor) * cell)
  const cumulative = [0]
  for (const m of mass) cumulative.push(cumulative[cumulative.length - 1] + m)
  const totalMass = cumulative[P]
  const bounds = [lo]
  for (let k = 1; k < settings.strata; k++) {
    const target = (totalMass * k) / settings.strata
    let i = 0
    while (i < P - 1 && cumulative[i + 1] < target) i++
    const b = Math.floor(lo + (i + (target - cumulative[i]) / (mass[i] || 1)) * cell)
    if (b > bounds[bounds.length - 1] && b < hi) bounds.push(b)
  }
  bounds.push(hi)
  const random = seededRandom(`${address}:${lo}:${hi}`)
  const windows: SampleWindow[] = []
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a0 = bounds[k]
    const a1 = bounds[k + 1]
    const length = a1 - a0
    const d = Math.max(density[Math.min(P - 1, Math.floor(((a0 + a1) / 2 - lo) / cell))], floor)
    const w = Math.max(1, Math.min(length, Math.round(settings.window / d)))
    const x = a0 + Math.floor(random() * length)
    const end = x + w
    const ranges: [number, number][] = end <= a1 ? [[x, end]] : [[x, a1], [a0, a0 + (end - a1)]]
    windows.push({ a0, a1, w, ranges })
  }
  return windows
}

// Counts the windows not counted yet (`onWindow` hears of each one as it
// ends, to save it), then scales every window up to its stratum.
const countWindows = async (
  rpc: SolanaRpcPool,
  address: string,
  windows: SampleWindow[],
  tipSlot: number,
  onWindow?: () => void
): Promise<RangeCount> => {
  let calls = 0
  await forEachConcurrent(
    windows.filter((win) => win.total === undefined),
    8,
    async (win) => {
      let t = 0
      let o = 0
      for (const [a, b] of win.ranges) {
        if (b <= a) continue
        const r = await countSlotRange(rpc, address, a, b, tipSlot)
        calls += r.calls
        t += r.total
        o += r.ok
      }
      win.total = t
      win.ok = o
      if (onWindow) onWindow()
    }
  )
  let total = 0
  let ok = 0
  for (const win of windows) {
    const scale = (win.a1 - win.a0) / win.w
    total += (win.total as number) * scale
    ok += (win.ok as number) * scale
  }
  return { total: Math.round(total), ok: Math.round(ok), calls }
}

// ---------------------------------------------------------------------------

// The range of a listing resumed from an earlier run (no plan from this one),
// to sample it when it passes its page cap: from its first slot to the newest
// signature it has seen, on top of the count it started from.
const resumedSampleJob = (address: string, job: SignatureJob): SampleJob => {
  const { signature: newestSig, slot: newestSlot } = jobNewest(job)
  if (job.rangeLo === undefined || !newestSig || newestSlot === undefined) {
    throw new Error(`[solana] internal error: ${address} resumed a listing without its range`)
  }
  const base: SignatureEntry | undefined = job.previousNewestSig
    ? {
        successful: job.baseSuccessful,
        failed: job.baseFailed,
        newestSig: job.previousNewestSig,
        newestSlot: job.previousNewestSlot,
        method: job.sampledBase ? "sampled" : "exact",
        updatedAt: job.createdAt,
      }
    : undefined
  return {
    lo: job.rangeLo,
    hi: newestSlot + 1,
    base,
    newest: { signature: newestSig, slot: newestSlot },
    createdAt: new Date().toISOString(),
  }
}

// Whether a saved sample still adds to the address's cached count (another
// run may have counted the address since).
const sameBase = (entry: SignatureEntry | undefined, base: SignatureEntry | undefined): boolean =>
  base
    ? !!entry && entry.newestSig === base.newestSig && entry.successful === base.successful && entry.failed === base.failed
    : !entry || !entry.newestSig

const slotHint = (createdAt: string | undefined, tipSlot: number): number | undefined => {
  if (!createdAt) return undefined
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created) || created >= Date.now()) return undefined
  // 10% earlier than the slot-time estimate: it only guides where to split.
  return Math.max(0, Math.floor(tipSlot - ((Date.now() - created) / SLOT_MS) * 1.1))
}

const estimateSettings = () => ({
  estimateAbove: envInt("SOLANA_ESTIMATE_ABOVE", 50000000),
  probes: envInt("SOLANA_ESTIMATE_PROBES", 64) || 64,
})

// Every setting of this provider, so a typo fails before the run starts
// (tags-routine preflight) instead of after the holder checks.
export const assertSolanaRpcSettings = (): void => {
  const lookback = String(process.env.SOLANA_TX_LOOKBACK_DAYS || "").trim()
  if (lookback && lookback !== "0") {
    throw new Error(
      `[solana] SOLANA_TX_LOOKBACK_DAYS=${lookback} is not supported by the rpc provider, which counts all-time. ` +
        "Set it to 0, or use SOLANA_TX_PROVIDER=dune."
    )
  }
  getSolanaCountMode()
  sampleSettings()
  estimateSettings()
  solanaRpcConfigs(defaultSolanaRpcUrl())
}

export const enrichSolanaTagsWithRpc = async (
  tags: Tag[],
  opts: SolanaRpcOptions = {}
): Promise<SolanaRpcEnrichmentResult> => {
  assertSolanaRpcSettings()
  const persist = opts.persist === undefined ? txCountCacheEnabled() : opts.persist
  const rpc = opts.rpc || defaultSolanaRpcPool()
  console.log(`[solana] RPC URL(s): ${rpc.labels().join(", ")}`)
  await rpc.assertKeysAccepted()

  const registriesByAddress = new Map<string, Set<string>>()
  for (const tag of tags) {
    const set = registriesByAddress.get(tag.tagAddress) || new Set<string>()
    set.add(tag.registry)
    registriesByAddress.set(tag.tagAddress, set)
  }
  const allAddresses = Array.from(registriesByAddress.keys())
  const valid = allAddresses.filter(isSolanaAddress)
  const invalid = allAddresses.filter((a) => !isSolanaAddress(a))
  if (invalid.length > 0) {
    console.warn(`[solana] ${invalid.length} invalid address(es) get txCount 0 (and 0 holders): ${invalid.join(", ")}`)
  }
  const registriesOf = (address: string) => registriesByAddress.get(address) || new Set<string>()

  const tokenMints = valid.filter((a) => registriesOf(a).has("tokens"))
  const holders = tokenMints.length > 0 ? await checkHolders(rpc, tokenMints) : {}

  // Mints that will be dropped for lack of holders need no tx count.
  const toCount = valid.filter((a) => {
    const regs = registriesOf(a)
    return !(regs.size === 1 && regs.has("tokens") && holders[a].holders < SOLANA_HOLDER_THRESHOLD)
  })

  let state: SolanaCache = { version: CACHE_VERSION, definition: SOLANA_RPC_DEFINITION, entries: {}, jobs: {}, samples: {} }
  if (persist) {
    const loaded = readCacheFile<SolanaCache>(CACHE_FILE)
    if (loaded && loaded.version === CACHE_VERSION && loaded.definition === SOLANA_RPC_DEFINITION) {
      state = { ...loaded, entries: loaded.entries || {}, jobs: loaded.jobs || {}, samples: loaded.samples || {} }
      // JSON stores a map's unmeasured points (NaN) as null.
      for (const address of Object.keys(state.samples)) {
        const map = state.samples[address].map
        if (map) map.density = map.density.map((d) => (typeof d === "number" ? d : NaN))
      }
    } else if (loaded) {
      console.warn("[solana] ignoring a cache written with another format or definition")
    }
  }
  const writer = new ThrottledWriter(2000)
  const save = () => {
    if (persist) writer.write("solana", CACHE_FILE, () => state)
  }

  const { estimateAbove, probes } = estimateSettings()
  const counted = new Set<string>()
  let pages = 0

  // Runs a saved sample to its end, saving as it goes: the map (when missing
  // or incomplete), the windows (drawn once), then each window as it is
  // counted. The result becomes the address's entry.
  const runSample = async (address: string, tip: number): Promise<void> => {
    const sample = state.samples[address]
    if (!sample.map || sample.map.lo !== sample.lo || sample.map.hi !== sample.hi || !isComplete(sample.map)) {
      sample.map = await mapRange(rpc, address, sample.lo, sample.hi, tip, 1, sample.map)
      delete sample.windows
      save()
    }
    if (!sample.windows) {
      sample.windows = drawWindows(address, sample.lo, sample.hi, sample.map)
      save()
    }
    const r = await countWindows(rpc, address, sample.windows, tip, save)
    const { base } = sample
    state.entries[address] = {
      successful: (base ? base.successful : 0) + r.ok,
      failed: (base ? base.failed : 0) + r.total - r.ok,
      newestSig: sample.newest.signature,
      newestSlot: sample.newest.slot,
      method: "sampled",
      updatedAt: new Date().toISOString(),
    }
    delete state.samples[address]
    delete state.jobs[address] // an abandoned listing ends with its sample
    counted.add(address)
    save()
    console.log(
      `[solana] ${address}: ~${r.total} signatures sampled in slots ${sample.lo}..${sample.hi - 1} ` +
        `(${sample.windows.length} windows, ${sample.map.calls + r.calls} calls)`
    )
  }

  try {
    const tipSlot = await rpc.call<number>("getSlot", [{ commitment: "finalized" }])
    const mode = getSolanaCountMode()
    // A count that tops up a sampled one ends sampled, also for a job saved
    // before that was recorded on it: while a job runs, its base is still the
    // cached entry.
    for (const address of Object.keys(state.jobs)) {
      const job = state.jobs[address]
      const entry = state.entries[address]
      if (entry && entry.method === "sampled" && job.previousNewestSig && entry.newestSig === job.previousNewestSig) {
        job.sampledBase = true
      }
    }
    // A sample an interrupted run left resumes in auto mode while it still adds
    // to the cached count (the listing it may have replaced is gone); exact
    // mode lists the address instead.
    const resumedSamples: string[] = []
    for (const address of Object.keys(state.samples)) {
      if (toCount.indexOf(address) < 0) continue
      if (mode === "auto" && sameBase(state.entries[address], state.samples[address].base)) {
        delete state.jobs[address]
        resumedSamples.push(address)
      } else {
        delete state.samples[address]
      }
    }
    // A listing abandoned at its page cap holds partial counts, never reused.
    // Auto mode samples its range up to the tip right away (listing it again
    // would only hit the cap again); exact mode drops it.
    const carried = new Set<string>()
    for (const address of Object.keys(state.jobs)) {
      if (!state.jobs[address].abandoned) continue
      if (mode === "auto" && state.jobs[address].rangeLo !== undefined && toCount.indexOf(address) >= 0) carried.add(address)
      else delete state.jobs[address]
    }
    const toSample: string[] = [] // addresses with a sample planned by this run
    const plans: { [address: string]: SampleJob } = {} // listed ranges, sampled if abandoned
    if (mode === "auto") {
      const { exactBelow, points } = sampleSettings()
      const now = new Date().toISOString()
      // Finished first: the count they end with is then topped up to the tip
      // below, like any cached count.
      if (resumedSamples.length > 0) {
        console.log(`[solana] Resuming ${resumedSamples.length} interrupted sample(s), then topping them up to the current tip`)
        await forEachConcurrent(resumedSamples, 8, (address) => runSample(address, tipSlot))
      }
      // An interrupted listing of this mode resumes, topped up to the tip. Other
      // interrupted counts (exact mode's, which can be huge) become an entry
      // when they only lacked their top-up, and are dropped otherwise:
      // sampling is cheaper than finishing them.
      const resumed = new Set<string>()
      for (const address of toCount) {
        const job = state.jobs[address]
        if (!job || carried.has(address)) continue
        if (job.segments.every((segment) => segment.done)) {
          state.entries[address] = finishJob(address, job)
          delete state.jobs[address]
        } else if (job.pageCap !== undefined && job.rangeLo !== undefined) {
          topUpResumedJob(job)
          resumed.add(address)
        } else {
          delete state.jobs[address]
        }
      }
      if (resumed.size > 0) console.log(`[solana] Resuming ${resumed.size} interrupted listing(s), each topped up to the current tip`)
      if (carried.size > 0) console.log(`[solana] ${carried.size} listing(s) passed their page cap in an earlier run: sampling them`)
      const quickStride = Math.floor(points / QUICK_MAP_POINTS)
      let listed = 0
      await forEachConcurrent(toCount, 8, async (address) => {
        if (resumed.has(address)) return
        const entry = state.entries[address]
        const base =
          entry && (entry.method === "exact" || entry.method === "sampled") && entry.newestSig && entry.newestSlot !== undefined
            ? entry
            : undefined
        const { page: top, complete } = await getNewestPage(rpc, address, base ? (base.newestSlot as number) : undefined)
        const newest = top[0]
        if (!newest || (base && newest.slot <= (base.newestSlot as number))) {
          if (!base && !newest) state.entries[address] = { successful: 0, failed: 0, method: "exact", updatedAt: now }
          counted.add(address)
          return
        }
        const hint = holders[address] ? slotHint(holders[address].createdAt, tipSlot) : undefined
        // A confirmed short newest page is the whole history: no need to search for its start.
        const whole = complete && !base
        const carriedLo = carried.has(address) ? state.jobs[address].rangeLo : undefined
        const lo = base
          ? (base.newestSlot as number) + 1
          : carriedLo !== undefined
          ? carriedLo
          : whole
          ? 0
          : (await findHistoryStart(rpc, address, tipSlot, hint)).start
        const hi = newest.slot + 1
        // The newest page already reaches below the range: count it from that page.
        if (whole || top.some((sig) => sig.slot < lo)) {
          delete state.jobs[address]
          const inRange = top.filter((sig) => sig.slot >= lo)
          const ok = inRange.filter((sig) => sig.err === null).length
          state.entries[address] = {
            successful: (base ? base.successful : 0) + ok,
            failed: (base ? base.failed : 0) + inRange.length - ok,
            newestSig: newest.signature,
            newestSlot: newest.slot,
            method: base ? base.method : "exact",
            updatedAt: now,
          }
          counted.add(address)
          save()
          return
        }
        const sampleJob = (map?: DensityMap): SampleJob => ({
          lo,
          hi,
          base: base ? { ...base } : undefined,
          newest: { signature: newest.signature, slot: newest.slot },
          ...(map ? { map } : {}),
          createdAt: now,
        })
        if (carried.has(address)) {
          state.samples[address] = sampleJob()
          delete state.jobs[address] // the sample replaces the abandoned listing
          toSample.push(address)
          save()
          return
        }
        // The sampler's own first pass sizes the range, a quick one first: a
        // range it puts far below SOLANA_EXACT_BELOW is listed without the
        // full map, and the others complete it (a sampled range reuses it).
        const quick = quickStride > 1 ? await mapRange(rpc, address, lo, hi, tipSlot, quickStride) : undefined
        const map =
          quick && quick.size <= exactBelow / QUICK_LIST_MARGIN ? quick : await mapRange(rpc, address, lo, hi, tipSlot, 1, quick)
        if (map.size <= exactBelow) {
          // From the history start found above when there is no cached count:
          // splits then never probe the slots before it.
          const job = newJob(base ? { ...base, method: "exact" } : undefined, base ? undefined : lo)
          job.pageCap = Math.ceil((1.25 * exactBelow) / PAGE_SIZE)
          job.rangeLo = lo
          if (base && base.method === "sampled") job.sampledBase = true
          state.jobs[address] = job
          plans[address] = sampleJob(map)
          listed++
        } else {
          state.samples[address] = sampleJob(map)
          toSample.push(address)
        }
        save()
      })
      console.log(
        `[solana] SOLANA_COUNT_MODE=auto: ${listed} range(s) listed exactly, ${toSample.length} sampled ` +
          `(mapped above SOLANA_EXACT_BELOW=${exactBelow} signatures)`
      )
    } else {
      // Every range is listed to its end here, including one an auto-mode run left.
      for (const address of toCount) {
        const job = state.jobs[address]
        if (job) delete job.pageCap
      }
      const resumed = toCount.filter((address) => state.jobs[address] && topUpResumedJob(state.jobs[address]))
      if (resumed.length > 0) {
        console.log(`[solana] Resuming ${resumed.length} interrupted count(s), each topped up to the current tip`)
        save()
      }
      // Addresses outside the Tokens registry (mostly programs) can have
      // billions of signatures: size them first and keep an estimate for the
      // ones too big to page.
      const toSize = toCount.filter((address) => {
        const entry = state.entries[address]
        return !state.jobs[address] && !registriesOf(address).has("tokens") && (!entry || entry.method === "estimated")
      })
      if (toSize.length > 0) console.log(`[solana] Sizing ${toSize.length} address(es) outside the Tokens registry before counting`)
      const estimated: string[] = []
      await forEachConcurrent(toSize, 4, async (address) => {
        const estimate = await estimateSignatures(rpc, address, probes, estimateAbove)
        const total = estimate.successful + estimate.failed
        // An exact answer here rests on one unconfirmed page, and histories below
        // the threshold are cheap: both are paged exactly below.
        if (estimate.small || estimate.exact || total <= estimateAbove) return
        console.warn(
          `[solana] ${address}: ~${total} signatures, above SOLANA_ESTIMATE_ABOVE=${estimateAbove}; ` +
            `using an estimate (${estimate.calls} calls) instead of paging every signature`
        )
        state.entries[address] = {
          successful: estimate.successful,
          failed: estimate.failed,
          newestSig: estimate.newestSig,
          newestSlot: estimate.newestSlot,
          method: "estimated",
          updatedAt: new Date().toISOString(),
        }
        counted.add(address)
        estimated.push(address)
        save()
      })
      if (estimated.length > 0) {
        // The sampler is unreliable on mints (-85% to +98% measured): say so when
        // a mint listed outside the Tokens registry gets an estimate.
        const owners = await getOwnerPrograms(rpc, estimated)
        for (const address of estimated) {
          if (TOKEN_PROGRAMS.indexOf(owners[address] || "") >= 0) {
            console.warn(
              `[solana] ${address} is a token mint listed in ${Array.from(registriesOf(address)).join(", ")}; ` +
                "its count is an estimate, which can be far off for mints"
            )
          }
        }
      }
      let fromScratch = 0
      for (const address of toCount) {
        if (state.jobs[address] || counted.has(address)) continue // resuming, or already settled above
        const entry = state.entries[address]
        const hint = holders[address] ? slotHint(holders[address].createdAt, tipSlot) : undefined
        const cached = entry && entry.method === "exact" ? entry : undefined
        if (!cached) fromScratch++
        state.jobs[address] = newJob(cached, hint)
        save()
      }
      if (fromScratch > 0) {
        // ~6 calls/s on free keys: a busy month counted from scratch takes a day
        // or more (September 2026: ~740M signatures, ~32 h).
        console.log(
          `[solana] ${fromScratch} address(es) have no cached count and are paged from their first signature. ` +
            "Large histories take hours on free tiers; `--mode prefetch` during the month avoids that at month-end."
        )
      }
    }

    const jobs: { [address: string]: SignatureJob } = {}
    for (const address of toCount) if (state.jobs[address] && !carried.has(address)) jobs[address] = state.jobs[address]
    const jobCount = Object.keys(jobs).length
    if (jobCount > 0) console.log(`[solana] Counting signatures for ${jobCount} address(es) (${rpc.capacity()} parallel requests max)`)
    // Ranges end at newest slots read after tipSlot, during planning (which can
    // take an hour), and windows are only anchored below the tip known here:
    // read it again before sampling instead of paging down from the live tip.
    const finalizedSlot = () => rpc.call<number>("getSlot", [{ commitment: "finalized" }])
    let sampleTip = toSample.length > 0 ? await finalizedSlot() : tipSlot
    // When one side fails the other still ends (with its progress saved)
    // before the error leaves this function and the cache is flushed.
    const [pageCount] = await settleAll(
      [
        jobCount > 0 ? runSignatureJobs(rpc, jobs, save) : Promise.resolve(0),
        // enough samplers in flight to keep every URL busy until the last one ends
        forEachConcurrent(toSample, 8, (address) => runSample(address, sampleTip)).then(() => 0),
      ],
      (err) => {
        if (!isBudgetExceeded(err)) {
          console.error(
            `[solana] ${message(err)}\n[solana] The other Solana counts keep running so their progress is saved; ` +
              "Ctrl+C stops them (progress is kept either way)."
          )
        }
      }
    )
    pages = pageCount
    const abandoned = Object.keys(jobs).filter((address) => jobs[address].abandoned)
    if (abandoned.length > 0) {
      console.log(`[solana] ${abandoned.length} listing(s) passed their page cap (larger than sized): sampling them instead`)
      for (const address of abandoned) {
        state.samples[address] = plans[address] || resumedSampleJob(address, jobs[address])
        delete state.jobs[address]
      }
      save()
      sampleTip = await finalizedSlot()
      await forEachConcurrent(abandoned, 8, (address) => runSample(address, sampleTip))
    }
    for (const address of Object.keys(jobs)) {
      if (jobs[address].abandoned) continue
      state.entries[address] = finishJob(address, jobs[address])
      delete state.jobs[address]
      counted.add(address)
    }
    save()
  } finally {
    writer.flush()
    console.log(
      "[solana] RPC calls: " + rpc.stats().map((e) => `${e.label} ${e.calls} (${e.rateLimited} 429s, ${e.errors} errors)`).join("; ")
    )
  }

  const byKey: { [cacheKey: string]: SolanaEnrichment } = {}
  for (const tag of tags) {
    const address = tag.tagAddress
    const entry = state.entries[address]
    const txCount = counted.has(address) && entry ? entry.successful : 0
    let totalHolders: number | null = null
    if (tag.registry === "tokens") totalHolders = holders[address] ? holders[address].holders : 0
    byKey[`${tag.chain}:${tag.registry}:${address}`] = { txCount, totalHolders }
  }

  const addresses: SolanaRpcAddressReport[] = allAddresses.map((address) => {
    const entry = state.entries[address]
    const holder = holders[address]
    let method: SolanaRpcAddressReport["method"] = "invalid"
    if (isSolanaAddress(address)) method = counted.has(address) && entry ? entry.method : "skipped-holders"
    return {
      address,
      registries: Array.from(registriesOf(address)),
      method,
      successful: counted.has(address) && entry ? entry.successful : 0,
      failed: counted.has(address) && entry ? entry.failed : 0,
      ...(holder ? { holders: holder.holders, holdersSource: holder.source } : {}),
    }
  })

  return {
    byKey,
    addresses,
    endpoints: rpc.labels(),
    pages,
    cacheDir: persist ? txCountCacheDir() : undefined,
  }
}
