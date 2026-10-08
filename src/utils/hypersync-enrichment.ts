import type { HypersyncClient, Query, RateLimitInfo } from "@envio-dev/hypersync-client"
import { httpFetch } from "./http"
import { checkDeadline, chunk, envInt, errorMessage as message, sleep } from "./runtime-helpers"
import { runSplittableWork, SplittableUnit } from "./split-scheduler"
import { readCacheFile, ThrottledWriter, txCountCacheDir, txCountCacheEnabled } from "./tx-count-cache"

// EVM transaction counts from Envio HyperSync (free API token at
// https://envio.dev/app/api-tokens). Same definition as the Dune query this
// replaces: all-time count of SUCCESSFUL top-level transactions whose `to` is
// the address, up to a pinned block per chain.
//
// HyperSync has no COUNT, so each matching transaction comes back as one row
// (only its `to` field) and is counted here. A request runs until the server's
// per-request limit (~5 s) and returns `nextBlock`; the next request resumes
// from there, so the scan has no gaps or overlaps.

export const HYPERSYNC_DEFINITION =
  "successful top-level txs with tx.to == address, all-time up to a pinned block " +
  "(status == 1; pre-Byzantium Ethereum, which has no status field: gasUsed < gas or the receipt has logs)"

// Per-chain caveats, recorded in the manifest. Kept out of HYPERSYNC_DEFINITION,
// which is part of every chain's cache key. HyperCore credits reach HyperEVM as
// system transactions (gas price 0) that the block's transaction root does not
// cover; HyperSync, like the official RPC, leaves them out (verify-counts checks).
const CHAIN_NOTES: { [chainId: string]: string } = {
  "999":
    "HyperEVM: user-signed transactions only. HyperCore-to-HyperEVM system transactions " +
    "(HYPE from 0x2222…2222, linked spot tokens from 0x20… addresses) are not counted, by design (README, HyperEVM); " +
    "explorers such as hyperevmscan.io include them, so their totals for linked contracts are higher.",
}

type HypersyncModule = typeof import("@envio-dev/hypersync-client")

const CACHE_VERSION = 1
// EIP-658 (receipt status) only exists from Byzantium on. Earlier Ethereum
// transactions have no status, so `status: 1` cannot match them; a separate
// pass counts them with the pre-Byzantium failure rule (see
// preByzantiumSucceeded).
const ETH_BYZANTIUM_BLOCK = 4370000
const JOIN_NOTHING = 2 // JoinMode.JoinNothing: return only the matching transactions
const MIN_SPLIT_BLOCKS = 2000
const PROGRESS_LOG_MS = 60000

export interface ScanTx {
  to?: string
  status?: number
  gas?: bigint
  gasUsed?: bigint
  logsBloom?: string
}

// A pre-Byzantium transaction that failed burnt all its gas and kept no logs
// (there was no REVERT yet), so either sign proves success. Gas alone misses
// successes that used exactly their gas limit: 20,819 of The DAO's 160,073,
// of which 20,811 have logs. A success with neither sign cannot be told from a
// failure without traces (a paid HyperSync add-on) and is not counted.
export const preByzantiumSucceeded = (tx: ScanTx): boolean =>
  (tx.gas !== undefined && tx.gasUsed !== undefined && tx.gasUsed < tx.gas) ||
  (typeof tx.logsBloom === "string" && /[1-9a-f]/i.test(tx.logsBloom.replace(/^0x/i, "")))

export type ScanFn = (
  chainId: string,
  query: Query
) => Promise<{ nextBlock: number; transactions: ScanTx[] }>

interface Segment {
  from: number // inclusive
  to: number // exclusive
  next: number // next block to request; finished when next >= to
  counts: { [address: string]: number }
  nullStatus?: { [address: string]: number } // pre-Byzantium pass only
}

interface ScanGroup {
  kind: "main" | "preByzantium"
  frontier: number // block every address of the group is already counted up to
  addresses: string[]
  segments: Segment[]
}

interface ScanJob {
  toBlock: number // exclusive pin shared by every address of the chain
  createdAt: string
  groups: ScanGroup[]
}

interface CacheEntry {
  count: number
  toBlock: number // exclusive: `count` covers blocks [0, toBlock)
  preByzantiumNullStatus?: number
  updatedAt: string
}

interface ChainCache {
  version: number
  definition: string
  chainId: string
  entries: { [address: string]: CacheEntry }
  job?: ScanJob | null
}

interface ChainPlan {
  chainId: string
  state: ChainCache
  requested: string[]
  invalid: string[]
  archiveHeight: number
  pin: number
  fromBlock: number
  rows: number
  requests: number
  scannedAddresses: number
  startedAt: number
}

export interface HypersyncChainReport {
  chainId: string
  toBlockExclusive: number
  archiveHeight: number
  addresses: number
  invalidAddresses: string[]
  scannedAddresses: number
  rows: number
  requests: number
  elapsedMs: number
  preByzantiumNullStatusRows?: number
  note?: string
}

export interface HypersyncCountResult {
  counts: { [chainId: string]: { [address: string]: number } }
  chains: HypersyncChainReport[]
  cacheDir?: string
}

export interface HypersyncCountOptions {
  // Read/write the persistent cache. Default: on unless TX_COUNT_CACHE=off.
  persist?: boolean
  // false also counts failed txs (verification only, never cached).
  successOnly?: boolean
  // Exclusive end block per chain instead of "archive height - margin".
  toBlockByChain?: { [chainId: string]: number }
  // Start block per chain instead of 0 (sampling; requires persist: false).
  fromBlockByChain?: { [chainId: string]: number }
  concurrency?: number
  // Test seams.
  scan?: ScanFn
  getHeight?: (chainId: string) => Promise<number>
}

const isAddress = (address: string): boolean => /^0x[0-9a-f]{40}$/.test(address)

// Also checked before the run starts (tags-routine preflight).
export const requireEnvioApiToken = (): string => {
  const apiToken = String(process.env.ENVIO_API_TOKEN || "").trim()
  if (!apiToken) {
    throw new Error(
      "[hypersync] ENVIO_API_TOKEN is not set. Create a free token at https://envio.dev/app/api-tokens " +
        "and add ENVIO_API_TOKEN=<token> to .env (or set EVM_TX_PROVIDER=dune)."
    )
  }
  return apiToken
}

// Requests per minute the scanner spaces itself to (0 = no pacing).
export const hypersyncRequestsPerMinute = (): number => envInt("HYPERSYNC_REQUESTS_PER_MINUTE", 14)

const cacheFileName = (chainId: string): string => `evm-hypersync-${chainId}.json`

export const hypersyncUrl = (chainId: string): string =>
  (process.env.HYPERSYNC_URL_TEMPLATE || "https://{chainId}.hypersync.xyz")
    .replace("{chainId}", chainId)
    .replace(/\/+$/, "")

let hypersyncModule: HypersyncModule | null = null
// Loaded on first use: it is a native module (prebuilt for macOS and Linux)
// and only this provider needs it. Also loaded before the run starts
// (tags-routine preflight), so a platform without it fails right away.
export const loadHypersync = (): HypersyncModule => {
  if (hypersyncModule) return hypersyncModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    hypersyncModule = require("@envio-dev/hypersync-client") as HypersyncModule
  } catch (err) {
    throw new Error(
      "[hypersync] Could not load @envio-dev/hypersync-client, which is prebuilt for macOS and Linux only " +
        `(on Windows, run under WSL, or set EVM_TX_PROVIDER=dune): ${message(err)}`
    )
  }
  hypersyncModule.setLogLevel(process.env.HYPERSYNC_LOG_LEVEL || "warn")
  return hypersyncModule
}

// GET /height needs no token. *.hypersync.xyz DNS is known to fail
// transiently (geographic load balancing), hence the retries.
export const getHypersyncHeight = async (chainId: string): Promise<number> => {
  const url = `${hypersyncUrl(chainId)}/height`
  let lastError: unknown
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await httpFetch(url, { timeout: 30000 })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const height = Number(((await res.json()) as { height?: unknown }).height)
      if (!Number.isSafeInteger(height) || height <= 0) throw new Error("unexpected /height response")
      return height
    } catch (err) {
      lastError = err
      if (attempt < 6) await sleep(Math.min(30000, 1000 * 2 ** attempt))
    }
  }
  throw new Error(`[hypersync] chain ${chainId}: could not read ${url} (${message(lastError)})`)
}

// The rate budget is per token and shared by every chain and every request
// of the process (the scan, the token probe and verify-counts' own queries). A
// free token's headers said 15 requests per 60 s window on 2026-10-06
// (x-ratelimit-limit 15000, cost 1000 each, whatever the page size), so
// requests are spaced out instead of bursting into 429s.
// HYPERSYNC_REQUESTS_PER_MINUTE=0 disables it.
let nextRequestAt = 0
const pace = async (): Promise<void> => {
  const perMinute = hypersyncRequestsPerMinute()
  if (!perMinute) return
  const now = Date.now()
  const at = Math.max(now, nextRequestAt)
  nextRequestAt = at + 60000 / perMinute
  if (at > now) await sleep(at - now)
}

class HypersyncScanner {
  private clients: { [chainId: string]: HypersyncClient } = {}

  constructor(private readonly apiToken: string) {}

  scan: ScanFn = async (chainId, query) => {
    await pace()
    const res = await this.client(chainId).get(query)
    return { nextBlock: res.nextBlock, transactions: res.data.transactions }
  }

  rateLimit(): RateLimitInfo | null {
    for (const chainId of Object.keys(this.clients)) {
      const info = this.clients[chainId].rateLimitInfo()
      if (info) return info
    }
    return null
  }

  // One cheap request without retries, so a bad token fails in a second
  // instead of after the client's ~40 s of retries.
  async probeToken(chainId: string, address: string, block: number): Promise<void> {
    const hs = loadHypersync()
    const client = new hs.HypersyncClient({
      url: hypersyncUrl(chainId),
      apiToken: this.apiToken,
      maxNumRetries: 0,
      httpReqTimeoutMillis: 60000,
    })
    try {
      await pace()
      await client.get(mainQuery([address], Math.max(0, block - 1), Math.max(1, block), true))
    } catch (err) {
      const text = message(err)
      if (/\b(401|403)\b/.test(text)) {
        throw new Error(
          `[hypersync] ENVIO_API_TOKEN was rejected (${text.slice(0, 300)}). ` +
            "Create a free token at https://envio.dev/app/api-tokens; a new token can take a few minutes to activate."
        )
      }
      console.warn(`[hypersync] Token probe failed with a non-auth error, continuing: ${text.slice(0, 300)}`)
    }
  }

  private client(chainId: string): HypersyncClient {
    if (!this.clients[chainId]) {
      const hs = loadHypersync()
      this.clients[chainId] = new hs.HypersyncClient({
        url: hypersyncUrl(chainId),
        apiToken: this.apiToken,
        httpReqTimeoutMillis: 120000,
        // The client also waits out 429s (x-ratelimit-reset) on its own.
        maxNumRetries: envInt("HYPERSYNC_MAX_RETRIES", 20),
      })
    }
    return this.clients[chainId]
  }
}

// Without maxNumTransactions the server ends a response at ~5,500 rows. The
// free tier limits requests, not rows, so a large page is far faster: a 24 h
// window of Base USDC (367,601 rows) came back in one 1.3 s request instead of
// 69. HYPERSYNC_MAX_ROWS_PER_REQUEST=0 leaves the server default.
const pageSize = (): { maxNumTransactions?: number } => {
  const rows = envInt("HYPERSYNC_MAX_ROWS_PER_REQUEST", 500000)
  return rows > 0 ? { maxNumTransactions: rows } : {}
}

const mainQuery = (addresses: string[], fromBlock: number, toBlock: number, successOnly: boolean): Query =>
  ({
    fromBlock,
    toBlock,
    transactions: [successOnly ? { to: addresses, status: 1 } : { to: addresses }],
    fieldSelection: { transaction: ["To"] },
    joinMode: JOIN_NOTHING,
    ...pageSize(),
  } as Query)

const preByzantiumQuery = (addresses: string[], fromBlock: number, toBlock: number): Query =>
  ({
    fromBlock,
    toBlock,
    transactions: [{ to: addresses }],
    fieldSelection: { transaction: ["To", "Status", "Gas", "GasUsed", "LogsBloom"] },
    joinMode: JOIN_NOTHING,
    ...pageSize(),
  } as Query)

class ScanUnit implements SplittableUnit {
  busy = false
  splitRequested = false
  requests = 0
  blocksPerRequest = 0

  constructor(
    readonly plan: ChainPlan,
    readonly group: ScanGroup,
    readonly segment: Segment,
    readonly addressSet: Set<string>
  ) {}

  isDone(): boolean {
    return this.segment.next >= this.segment.to
  }

  remainingWork(): number {
    const remaining = this.segment.to - this.segment.next
    if (!this.requests || !this.blocksPerRequest || remaining < 2 * MIN_SPLIT_BLOCKS) return 0
    return remaining / this.blocksPerRequest
  }
}

const freshState = (chainId: string): ChainCache => ({
  version: CACHE_VERSION,
  definition: HYPERSYNC_DEFINITION,
  chainId,
  entries: {},
  job: null,
})

const createJob = (plan: ChainPlan, needed: string[], successOnly: boolean): ScanJob => {
  const byFrontier = new Map<number, string[]>()
  for (const address of needed) {
    const entry = plan.state.entries[address]
    const frontier = entry ? entry.toBlock : plan.fromBlock
    const list = byFrontier.get(frontier) || []
    list.push(address)
    byFrontier.set(frontier, list)
  }
  const perQuery = envInt("HYPERSYNC_ADDRESSES_PER_QUERY", 500) || 500
  const groups: ScanGroup[] = []
  byFrontier.forEach((addresses, frontier) => {
    for (const part of chunk(addresses, perQuery)) {
      groups.push({
        kind: "main",
        frontier,
        addresses: part,
        segments: [{ from: frontier, to: plan.pin, next: frontier, counts: {} }],
      })
      if (successOnly && plan.chainId === "1" && frontier < ETH_BYZANTIUM_BLOCK) {
        const end = Math.min(ETH_BYZANTIUM_BLOCK, plan.pin)
        groups.push({
          kind: "preByzantium",
          frontier,
          addresses: part,
          segments: [{ from: frontier, to: end, next: frontier, counts: {}, nullStatus: {} }],
        })
      }
    }
  })
  return { toBlock: plan.pin, createdAt: new Date().toISOString(), groups }
}

const addInto = (target: { [k: string]: number }, source?: { [k: string]: number }) => {
  if (!source) return
  for (const key of Object.keys(source)) target[key] = (target[key] || 0) + source[key]
}

// Folds a finished scan into the cache entries: every address of the job is
// now counted up to job.toBlock.
const mergeJob = (plan: ChainPlan): void => {
  const job = plan.state.job
  if (!job) return
  const delta: { [address: string]: number } = {}
  const nulls: { [address: string]: number } = {}
  for (const group of job.groups) {
    for (const segment of group.segments) {
      if (segment.next < segment.to) {
        throw new Error(`[hypersync] internal error: chain ${plan.chainId} merged an unfinished scan`)
      }
      addInto(delta, segment.counts)
      addInto(nulls, segment.nullStatus)
    }
  }
  const now = new Date().toISOString()
  for (const group of job.groups) {
    if (group.kind !== "main") continue
    for (const address of group.addresses) {
      const prev = plan.state.entries[address]
      if ((prev ? prev.toBlock : plan.fromBlock) !== group.frontier) {
        throw new Error(
          `[hypersync] cache entry for ${address} on chain ${plan.chainId} changed during a scan. ` +
            `Delete ${cacheFileName(plan.chainId)} in ${txCountCacheDir()} and rerun.`
        )
      }
      const nullStatus = (prev && prev.preByzantiumNullStatus ? prev.preByzantiumNullStatus : 0) + (nulls[address] || 0)
      plan.state.entries[address] = {
        count: (prev ? prev.count : 0) + (delta[address] || 0),
        toBlock: job.toBlock,
        ...(nullStatus ? { preByzantiumNullStatus: nullStatus } : {}),
        updatedAt: now,
      }
    }
  }
  plan.state.job = null
}

const logProgress = (plans: ChainPlan[], scanner: HypersyncScanner | null): void => {
  for (const plan of plans) {
    const job = plan.state.job
    if (!job) continue
    let total = 0
    let done = 0
    let segments = 0
    for (const group of job.groups) {
      for (const segment of group.segments) {
        total += segment.to - segment.from
        done += Math.min(segment.next, segment.to) - segment.from
        segments++
      }
    }
    const pct = total ? ((100 * done) / total).toFixed(1) : "100.0"
    console.log(
      `[hypersync] chain ${plan.chainId}: ${pct}% of blocks scanned, ${plan.rows} txs counted, ` +
        `${plan.requests} requests, ${segments} segment(s)`
    )
  }
  const info = scanner ? scanner.rateLimit() : null
  if (info) console.log(`[hypersync] rate limit: ${JSON.stringify(info)}`)
}

const runJobs = async (
  plans: ChainPlan[],
  scan: ScanFn,
  concurrency: number,
  save: (plan: ChainPlan) => void,
  successOnly: boolean,
  scanner: HypersyncScanner | null
): Promise<void> => {
  const units: ScanUnit[] = []
  for (const plan of plans) {
    const job = plan.state.job
    if (!job) continue
    for (const group of job.groups) {
      const addressSet = new Set(group.addresses)
      for (const segment of group.segments) {
        if (segment.next < segment.to) units.push(new ScanUnit(plan, group, segment, addressSet))
      }
    }
  }
  if (units.length === 0) return

  const step = async (unit: ScanUnit): Promise<void> => {
    checkDeadline()
    const { plan, group, segment } = unit
    const from = segment.next
    const query =
      group.kind === "main"
        ? mainQuery(group.addresses, from, segment.to, successOnly)
        : preByzantiumQuery(group.addresses, from, segment.to)
    let res: { nextBlock: number; transactions: ScanTx[] } | null = null
    for (let attempt = 1; ; attempt++) {
      try {
        res = await scan(plan.chainId, query)
      } catch (err) {
        throw new Error(`[hypersync] chain ${plan.chainId}, blocks ${from}..${segment.to - 1}: ${message(err)}`)
      }
      if (res.nextBlock > from) break
      if (attempt >= 3) {
        throw new Error(`[hypersync] chain ${plan.chainId}: no progress at block ${from} after ${attempt} requests`)
      }
      await sleep(2000 * attempt)
    }
    if (!res) throw new Error("[hypersync] internal error: no response")
    if (res.nextBlock > segment.to) {
      throw new Error(
        `[hypersync] chain ${plan.chainId}: nextBlock ${res.nextBlock} is past the requested end ${segment.to}`
      )
    }
    // Every row is checked before any is counted: a step that throws halfway
    // would leave part of the page in the counts, a later checkpoint would
    // save it, and the rerun would count that page again.
    for (const tx of res.transactions) {
      if (!unit.addressSet.has(String(tx.to || "").toLowerCase())) {
        throw new Error(`[hypersync] chain ${plan.chainId}: unexpected tx.to "${tx.to}" in the response`)
      }
    }
    for (const tx of res.transactions) {
      const to = String(tx.to || "").toLowerCase()
      if (group.kind === "main") {
        segment.counts[to] = (segment.counts[to] || 0) + 1
      } else if (tx.status !== 0 && tx.status !== 1) {
        // Status 1 rows were already counted by the main pass; 0 is a failure.
        const nullStatus = segment.nullStatus || (segment.nullStatus = {})
        nullStatus[to] = (nullStatus[to] || 0) + 1
        if (preByzantiumSucceeded(tx)) {
          segment.counts[to] = (segment.counts[to] || 0) + 1
        }
      }
    }
    segment.next = res.nextBlock
    const advance = res.nextBlock - from
    unit.blocksPerRequest = unit.blocksPerRequest ? 0.7 * unit.blocksPerRequest + 0.3 * advance : advance
    unit.requests++
    plan.requests++
    plan.rows += res.transactions.length
    save(plan)
  }

  const split = async (unit: ScanUnit): Promise<ScanUnit | null> => {
    const { segment } = unit
    const remaining = segment.to - segment.next
    if (remaining < 2 * MIN_SPLIT_BLOCKS) return null
    const mid = segment.next + Math.floor(remaining / 2)
    const upper: Segment = { from: mid, to: segment.to, next: mid, counts: {} }
    if (unit.group.kind === "preByzantium") upper.nullStatus = {}
    segment.to = mid
    unit.group.segments.push(upper)
    save(unit.plan)
    return new ScanUnit(unit.plan, unit.group, upper, unit.addressSet)
  }

  const timer = setInterval(() => logProgress(plans, scanner), PROGRESS_LOG_MS)
  try {
    await runSplittableWork(units, concurrency, step, split)
  } finally {
    clearInterval(timer)
    logProgress(plans, scanner)
  }
}

export const countEvmTxsWithHypersync = async (
  addressesByChain: { [chainId: string]: string[] },
  opts: HypersyncCountOptions = {}
): Promise<HypersyncCountResult> => {
  const persist = opts.persist === undefined ? txCountCacheEnabled() : opts.persist
  const successOnly = opts.successOnly !== false
  if ((!successOnly || opts.fromBlockByChain) && persist) {
    throw new Error("[hypersync] successOnly=false and fromBlockByChain are for verification only and cannot use the cache")
  }
  const getHeight = opts.getHeight || getHypersyncHeight
  const concurrency = opts.concurrency || envInt("HYPERSYNC_CONCURRENCY", 3) || 3
  const margin = envInt("HYPERSYNC_REORG_MARGIN_BLOCKS", 200)
  const writer = new ThrottledWriter(2000)
  const save = (plan: ChainPlan) => {
    if (persist) writer.write(plan.chainId, cacheFileName(plan.chainId), () => plan.state)
  }

  let scanner: HypersyncScanner | null = null
  let tokenProbed = false
  const getScan = async (plans: ChainPlan[]): Promise<ScanFn> => {
    if (opts.scan) return opts.scan
    if (!scanner) scanner = new HypersyncScanner(requireEnvioApiToken())
    if (!tokenProbed) {
      const plan = plans.find((p) => p.state.job && p.state.job.groups.length > 0)
      if (plan && plan.state.job) {
        await scanner.probeToken(plan.chainId, plan.state.job.groups[0].addresses[0], plan.state.job.toBlock)
      }
      tokenProbed = true
    }
    return scanner.scan
  }

  const plans: ChainPlan[] = []
  for (const chainId of Object.keys(addressesByChain)) {
    const normalized = Array.from(
      new Set(addressesByChain[chainId].map((a) => String(a || "").trim().toLowerCase()))
    )
    const requested = normalized.filter(isAddress)
    const invalid = normalized.filter((a) => !isAddress(a))
    if (invalid.length > 0) {
      console.warn(`[hypersync] chain ${chainId}: ${invalid.length} invalid address(es) get txCount 0: ${invalid.join(", ")}`)
    }
    let state = freshState(chainId)
    if (persist && requested.length > 0) {
      const loaded = readCacheFile<ChainCache>(cacheFileName(chainId))
      if (loaded && loaded.version === CACHE_VERSION && loaded.definition === HYPERSYNC_DEFINITION && loaded.chainId === chainId) {
        state = loaded
        if (!state.entries) state.entries = {}
      } else if (loaded) {
        console.warn(`[hypersync] chain ${chainId}: ignoring a cache written with another format or definition`)
      }
    }
    plans.push({
      chainId,
      state,
      requested,
      invalid,
      archiveHeight: 0,
      pin: 0,
      fromBlock: opts.fromBlockByChain && opts.fromBlockByChain[chainId] ? opts.fromBlockByChain[chainId] : 0,
      rows: 0,
      requests: 0,
      scannedAddresses: 0,
      startedAt: Date.now(),
    })
  }

  try {
    // 1) Finish scans an earlier, interrupted run left behind.
    const resumable = plans.filter((p) => p.state.job)
    if (resumable.length > 0) {
      console.log(`[hypersync] Resuming ${resumable.length} unfinished scan(s) from ${txCountCacheDir()}`)
      const scan = await getScan(resumable)
      await runJobs(resumable, scan, concurrency, save, successOnly, scanner)
      for (const plan of resumable) {
        mergeJob(plan)
        save(plan)
      }
      writer.flush()
    }

    // 2) Pin every chain and scan what the cache does not cover yet.
    for (const plan of plans) {
      if (plan.requested.length === 0) continue
      plan.archiveHeight = await getHeight(plan.chainId)
      const fixed = opts.toBlockByChain ? opts.toBlockByChain[plan.chainId] : undefined
      let pin = fixed !== undefined ? fixed : plan.archiveHeight + 1 - margin
      if (pin <= plan.fromBlock || pin > plan.archiveHeight + 1) {
        throw new Error(
          `[hypersync] chain ${plan.chainId}: end block ${pin} is outside HyperSync's archive (height ${plan.archiveHeight})`
        )
      }
      // Keep one cutoff per chain: never leave an address behind the others.
      for (const address of plan.requested) {
        const entry = plan.state.entries[address]
        if (entry && entry.toBlock > pin) pin = entry.toBlock
      }
      if (pin > plan.archiveHeight + 1) {
        throw new Error(
          `[hypersync] chain ${plan.chainId}: HyperSync's archive (height ${plan.archiveHeight}) is behind the cached ` +
            `cutoff (block ${pin - 1}); its node is probably lagging. Retry in a few minutes.`
        )
      }
      plan.pin = pin
      const needed = plan.requested.filter((a) => {
        const entry = plan.state.entries[a]
        return entry ? entry.toBlock < pin : plan.fromBlock < pin
      })
      plan.scannedAddresses = needed.length
      if (needed.length > 0) {
        plan.state.job = createJob(plan, needed, successOnly)
        save(plan)
      }
      console.log(
        `[hypersync] chain ${plan.chainId}: ${plan.requested.length} address(es), ${needed.length} to scan, ` +
          `counting through block ${pin - 1} (archive height ${plan.archiveHeight})`
      )
    }
    const pending = plans.filter((p) => p.state.job)
    if (pending.length > 0) {
      const scan = await getScan(pending)
      await runJobs(pending, scan, concurrency, save, successOnly, scanner)
      for (const plan of pending) {
        mergeJob(plan)
        save(plan)
      }
    }
  } finally {
    writer.flush()
  }

  const counts: HypersyncCountResult["counts"] = {}
  const chains: HypersyncChainReport[] = []
  for (const plan of plans) {
    counts[plan.chainId] = {}
    let nullStatusRows = 0
    for (const address of plan.requested) {
      const entry = plan.state.entries[address]
      if (!entry || entry.toBlock !== plan.pin) {
        throw new Error(`[hypersync] internal error: ${address} on chain ${plan.chainId} is not counted up to the cutoff`)
      }
      counts[plan.chainId][address] = entry.count
      nullStatusRows += entry.preByzantiumNullStatus || 0
    }
    for (const address of plan.invalid) counts[plan.chainId][address] = 0
    chains.push({
      chainId: plan.chainId,
      toBlockExclusive: plan.pin,
      archiveHeight: plan.archiveHeight,
      addresses: plan.requested.length,
      invalidAddresses: plan.invalid,
      scannedAddresses: plan.scannedAddresses,
      rows: plan.rows,
      requests: plan.requests,
      elapsedMs: Date.now() - plan.startedAt,
      ...(nullStatusRows ? { preByzantiumNullStatusRows: nullStatusRows } : {}),
      ...(CHAIN_NOTES[plan.chainId] ? { note: CHAIN_NOTES[plan.chainId] } : {}),
    })
  }
  return { counts, chains, cacheDir: persist ? txCountCacheDir() : undefined }
}

// Transactions sent by any of `senders` in [fromBlock, toBlock) (verification).
export const countTransactionsFrom = async (
  chainId: string,
  senders: string[],
  fromBlock: number,
  toBlock: number
): Promise<number> => {
  const apiToken = requireEnvioApiToken()
  const hs = loadHypersync()
  const client = new hs.HypersyncClient({ url: hypersyncUrl(chainId), apiToken, maxNumRetries: 3 })
  let rows = 0
  for (let next = fromBlock; next < toBlock; ) {
    await pace()
    const res = await client.get({
      fromBlock: next,
      toBlock,
      transactions: [{ from: senders }],
      fieldSelection: { transaction: ["Hash"] },
      joinMode: JOIN_NOTHING,
    } as Query)
    rows += res.data.transactions.length
    if (res.nextBlock <= next) throw new Error(`[hypersync] chain ${chainId}: no progress at block ${next}`)
    next = res.nextBlock
  }
  return rows
}

// Lowest block HyperSync returns for [0, 100) on a chain (verification of
// history coverage: anything above 0 or 1 means early history is missing).
export const firstIndexedBlock = async (chainId: string): Promise<number | null> => {
  const apiToken = requireEnvioApiToken()
  const hs = loadHypersync()
  const client = new hs.HypersyncClient({ url: hypersyncUrl(chainId), apiToken, maxNumRetries: 3 })
  await pace()
  const res = await client.get({
    fromBlock: 0,
    toBlock: 100,
    includeAllBlocks: true,
    fieldSelection: { block: ["Number"] },
  } as Query)
  const numbers = res.data.blocks.map((b) => Number(b.number)).filter((n) => Number.isFinite(n))
  return numbers.length > 0 ? Math.min(...numbers) : null
}
