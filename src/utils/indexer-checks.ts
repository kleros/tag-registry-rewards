import { ethers, utils } from "ethers"
import fetch from "node-fetch"
import conf from "../config"
import { Period } from "../types"
import { sleep } from "../transaction-sender"
import { findChainConfig } from "./chains"
import { ExclusionList, loadExclusions, namedByItemId } from "./exclusions"
import { hypersyncUrl, loadHypersync, requireEnvioApiToken } from "./hypersync-enrichment"
import { ensureChainId, rpcsForChain } from "./prediction-market-detection"
import { errorMessage } from "./runtime-helpers"

// The indexer (XDAI_GTCR_SUBGRAPH_URL) is the only place the registries are
// read from, and every item it gets wrong in a period is silently unpaid while
// its share goes to the others. Besides blank items (item-data.ts), it can
// get items wrong in four ways, all checked here against Gnosis itself before
// a run reads it:
// - it has not processed the end of the period yet: the last days' items are
//   still "requested", not registered (an indexer behind or stuck);
// - it never stored an item at all (an event it missed): every item a
//   registry ever created on-chain (its NewItem events) must be in the indexer;
// - it stored an item in the wrong state: it reads each item's status from
//   the registry when an event comes in and caches the answer, a failed read
//   included (zeros), after which the item stays "requested" for good. Every
//   item's status and number of requests must be the registry's own;
// - it lost or garbled a request: the same failed read stores a request
//   under index -1, typed "Absent", with no requester, and its resolution is
//   never written, while the item's own status can be right again. Every
//   request must be there, typed, with a requester, and resolved unless it is
//   the item's pending one: a removal or registration missing from them is
//   never paid.
// A problem on an item active since the period started (some event of the
// registry names it) stops the run, unless exclusions.json names the item,
// which then is not paid automatically. One on an item untouched since cannot
// change the period's payout: a warning, so that an old glitch does not block
// every month. INDEXER_CHECK=off skips it all (the tests do, having no Gnosis).

const GNOSIS = "100"
const NEW_ITEM = utils.id("NewItem(bytes32,string,bool)")
const PAGE_SIZE = 1000
const STATUSES = ["Absent", "Registered", "RegistrationRequested", "ClearingRequested"]
const REQUEST_TYPES = ["RegistrationRequested", "ClearingRequested"]

export const indexerCheckEnabled = (): boolean =>
  !/^(off|false|0|no)$/i.test(String(process.env.INDEXER_CHECK || "").trim())

export interface ItemState {
  status: string
  requests: number
}

// The events of one registry, up to a block.
export interface RegistryEvents {
  // the itemID of every NewItem
  created: string[]
  // for each itemID an event names, the block and time of the latest one
  lastEvent: Map<string, { block: number; time: number }>
}

// What a check reads from Gnosis.
export interface GnosisReader {
  blockTime(block: number): Promise<number>
  // the registry's events in blocks below `toBlock`
  registryEvents(registry: string, toBlock: number): Promise<RegistryEvents>
  // each item's status and number of requests at `block`, from the registry
  itemStates(registry: string, ids: string[], block: number): Promise<Map<string, ItemState>>
}

const registryAbi = new utils.Interface([
  "function getItemInfo(bytes32 _itemID) view returns (uint8 status, uint256 numberOfRequests, uint256 sumDeposit)",
])
const multicall = new utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
])
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
const STATE_BATCH = 500

// HyperSync and the Gnosis RPC can trail the indexer by a few blocks: a block
// they do not have yet is waited for (up to a minute), not taken as an error.
const LAG_WAITS = 20
const LAG_WAIT_SECONDS = 3

const gnosisReader = (): GnosisReader => {
  const hs = loadHypersync()
  const client = new hs.HypersyncClient({ url: hypersyncUrl(GNOSIS), apiToken: requireEnvioApiToken(), maxNumRetries: 20 })
  const chain = findChainConfig(GNOSIS)
  if (!chain) throw new Error("[indexer-check] Gnosis (100) is not in src/utils/chains.ts")
  const providers = rpcsForChain(chain).map((url) => new ethers.providers.StaticJsonRpcProvider({ url, timeout: 60000 }, 100))
  return {
    blockTime: async (block) => {
      for (let waits = 0; ; waits++) {
        const res = await client.get({ fromBlock: block, toBlock: block + 1, includeAllBlocks: true, fieldSelection: { block: ["Number", "Timestamp"] } })
        const found = (res.data.blocks || []).find((b: { number: number }) => Number(b.number) === block)
        if (found) return Number(found.timestamp)
        if (waits >= LAG_WAITS) throw new Error(`HyperSync has no block ${block} on Gnosis`)
        await sleep(LAG_WAIT_SECONDS)
      }
    },
    registryEvents: async (registry, toBlock) => {
      const created = new Set<string>()
      const lastEvent = new Map<string, { block: number; time: number }>()
      const times = new Map<number, number>()
      let from = 0
      let waits = 0
      while (from < toBlock) {
        const res = await client.get({
          fromBlock: from,
          toBlock,
          logs: [{ address: [registry] }],
          fieldSelection: { log: ["BlockNumber", "Topic0", "Topic1"], block: ["Number", "Timestamp"] },
        })
        for (const b of res.data.blocks || []) times.set(Number(b.number), Number(b.timestamp))
        for (const log of res.data.logs || []) {
          // every event naming an item names it first (NewItem, RequestSubmitted,
          // ItemStatusChange, Contribution…); other events add harmless ids
          const id = log.topics && log.topics[1] ? String(log.topics[1]).toLowerCase() : ""
          if (!id) continue
          const block = Number(log.blockNumber)
          const time = times.get(block)
          if (time === undefined) throw new Error(`HyperSync gave no time for block ${block}`)
          if (String(log.topics[0]).toLowerCase() === NEW_ITEM) created.add(id)
          const seen = lastEvent.get(id)
          if (!seen || seen.block < block) lastEvent.set(id, { block, time })
        }
        if (res.nextBlock > from) {
          from = res.nextBlock
          waits = 0
        } else if (++waits > LAG_WAITS) {
          throw new Error(`HyperSync has not reached block ${toBlock - 1} (stuck at ${from})`)
        } else {
          await sleep(LAG_WAIT_SECONDS)
        }
      }
      return { created: Array.from(created), lastEvent }
    },
    itemStates: async (registry, ids, block) => {
      const states = new Map<string, ItemState>()
      for (let i = 0; i < ids.length; i += STATE_BATCH) {
        const part = ids.slice(i, i + STATE_BATCH)
        const data = multicall.encodeFunctionData("aggregate3", [
          part.map((id) => ({ target: registry, allowFailure: false, callData: registryAbi.encodeFunctionData("getItemInfo", [id]) })),
        ])
        let results: { returnData: string }[] | null = null
        let lastError: unknown
        // a node that has not reached `block` yet refuses it: waited for too
        for (let attempt = 0; attempt < Math.max(LAG_WAITS, 3 * providers.length) && results === null; attempt++) {
          const provider = providers[attempt % providers.length]
          try {
            await ensureChainId(chain, provider)
            const out = await provider.call({ to: MULTICALL3, data }, block)
            results = multicall.decodeFunctionResult("aggregate3", out)[0] as { returnData: string }[]
          } catch (err) {
            lastError = err
            await sleep(LAG_WAIT_SECONDS)
          }
        }
        if (results === null) throw new Error(`no Gnosis RPC answered getItemInfo at block ${block} (${errorMessage(lastError)})`)
        if (results.length !== part.length) throw new Error(`Multicall3 answered ${results.length} of ${part.length} getItemInfo calls`)
        part.forEach((id, j) => {
          const [status, numberOfRequests] = registryAbi.decodeFunctionResult("getItemInfo", (results as { returnData: string }[])[j].returnData)
          states.set(id, { status: STATUSES[Number(status)] || `status ${status}`, requests: Number(numberOfRequests) })
        })
      }
      return states
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the indexer's JSON, read field by field below
const query = async (body: string): Promise<any> => {
  const response = await fetch(conf.XDAI_GTCR_SUBGRAPH_URL, {
    method: "POST",
    body: JSON.stringify({ query: body }),
    headers: { "Content-Type": "application/json" },
  })
  if (!response.ok) throw new Error(`[indexer-check] indexer HTTP ${response.status}`)
  const json = await response.json()
  if (json.errors || !json.data) throw new Error(`[indexer-check] bad indexer response: ${JSON.stringify(json).slice(0, 300)}`)
  return json.data
}

// The last Gnosis block the indexer has processed.
const indexerProgress = async (): Promise<number> => {
  const data = await query("{ _meta { chainId progressBlock } }")
  const gnosis = (data._meta || []).find((m: { chainId: number | string }) => String(m.chainId) === GNOSIS)
  if (!gnosis || !Number.isFinite(Number(gnosis.progressBlock))) {
    throw new Error("[indexer-check] the indexer does not report how far it has processed Gnosis (_meta.progressBlock)")
  }
  return Number(gnosis.progressBlock)
}

export interface IndexedRequest {
  id: string
  requestType: string
  resolved: boolean
  resolutionTime: string | number
  requester: string
}

interface IndexedItem extends ItemState {
  requestList: IndexedRequest[]
}

// Paged by id (keyset): an item that changes while the pages are read cannot
// shift the next page and hide an item, as an offset could.
const indexedItems = async (registry: string): Promise<Map<string, IndexedItem>> => {
  const items = new Map<string, IndexedItem>()
  let after = ""
  for (;;) {
    const data = await query(
      `{ litems:LItem(where: { registryAddress: {_eq:"${registry}"}, id: {_gt: "${after}"} }, limit: ${PAGE_SIZE}, order_by: {id: asc}) ` +
        "{ id itemID status numberOfRequests requests { id requestType resolved resolutionTime requester } } }"
    )
    const page: { id: string; itemID: string; status: string; numberOfRequests: string | number; requests?: IndexedRequest[] }[] =
      data.litems || []
    for (const item of page) {
      items.set(String(item.itemID).toLowerCase(), {
        status: item.status,
        requests: Number(item.numberOfRequests),
        requestList: item.requests || [],
      })
    }
    if (page.length < PAGE_SIZE) return items
    after = page[page.length - 1].id
  }
}

const ZERO_ADDRESS = /^0x0{40}$/i
const resolvedAt = (request: IndexedRequest): number => (request.resolved ? Number(request.resolutionTime) || 0 : 0)

// What is wrong with an item's requests, given the registry's own state of it
// (status and number of requests), or "" when nothing is.
export const requestProblem = (requests: IndexedRequest[], chain: ItemState): string => {
  const byIndex = new Map<number, IndexedRequest>()
  for (const request of requests) {
    const m = /-(-?\d+)$/.exec(request.id)
    const index = m ? Number(m[1]) : NaN
    if (!(index >= 0 && index < chain.requests) || byIndex.has(index)) return `request ${request.id} is not one of its ${chain.requests}`
    byIndex.set(index, request)
  }
  if (byIndex.size !== chain.requests) return `${byIndex.size} of its ${chain.requests} requests are in the indexer`
  const pending = chain.status === "RegistrationRequested" || chain.status === "ClearingRequested"
  for (let index = 0; index < chain.requests; index++) {
    const request = byIndex.get(index) as IndexedRequest
    if (!REQUEST_TYPES.includes(request.requestType)) return `request ${index} is typed "${request.requestType}"`
    if (!request.requester || ZERO_ADDRESS.test(request.requester)) return `request ${index} has no requester`
    const last = index === chain.requests - 1
    if (last && pending) {
      if (request.requestType !== chain.status || resolvedAt(request) > 0) return `its pending ${chain.status} is request ${index}, ${request.requestType}${request.resolved ? ", resolved" : ""}`
    } else if (resolvedAt(request) === 0) {
      return `request ${index} (${request.requestType}) has no resolution`
    }
  }
  return ""
}

const listed = (lines: string[]): string => lines.slice(0, 5).join("; ") + (lines.length > 5 ? `; … (${lines.length} in all)` : "")

// One registry: every item created on-chain is in the indexer, nothing else
// is, and each one is in the registry's own state with all its requests. The
// indexer keeps processing while it is read, so the items an event names
// between the first progress read and the last are left out of the
// comparison: their state in the indexer may be from either side of it.
const checkRegistry = async (
  registry: string,
  before: number,
  periodStart: number,
  gnosis: GnosisReader,
  exclusions: ExclusionList
): Promise<number> => {
  const indexed = await indexedItems(registry)
  const after = await indexerProgress()
  const events = await gnosis.registryEvents(registry, after + 1)
  const touched = (id: string) => {
    const e = events.lastEvent.get(id)
    return !!e && e.block > before
  }
  const active = (id: string) => {
    const e = events.lastEvent.get(id)
    return !e || e.time >= periodStart
  }
  const onChain = new Set(events.created)
  const unknown = Array.from(indexed.keys()).filter((id) => !onChain.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `[indexer-check] registry ${registry}: the indexer holds ${unknown.length} item(s) Gnosis shows no NewItem for ` +
        `(${listed(unknown)}): the read of Gnosis is incomplete or the indexer is wrong. Rerun; if it persists, investigate.`
    )
  }
  const problems: { id: string; why: string }[] = []
  for (const id of events.created) {
    if (!indexed.has(id) && !touched(id)) problems.push({ id, why: "created on Gnosis, not in the indexer" })
  }
  const compared = Array.from(indexed.keys()).filter((id) => !touched(id))
  const states = await gnosis.itemStates(registry, compared, after)
  for (const id of compared) {
    const mine = indexed.get(id) as IndexedItem
    const theirs = states.get(id)
    if (!theirs) problems.push({ id, why: "no state read from Gnosis" })
    else if (theirs.status !== mine.status || theirs.requests !== mine.requests) {
      problems.push({ id, why: `indexer ${mine.status}/${mine.requests} request(s), Gnosis ${theirs.status}/${theirs.requests}` })
    } else {
      const why = requestProblem(mine.requestList, theirs)
      if (why) problems.push({ id, why })
    }
  }

  const blocking: string[] = []
  const tolerated: string[] = []
  for (const p of problems) {
    const line = `${p.id}: ${p.why}`
    if (!active(p.id)) tolerated.push(`${line} (untouched since before the period)`)
    else if (namedByItemId(exclusions, p.id)) tolerated.push(`${line} (named in ${exclusions.path}: not paid automatically)`)
    else blocking.push(line)
  }
  if (tolerated.length > 0) {
    console.warn(`[indexer-check] WARNING registry ${registry}: ${tolerated.length} item(s) wrong in the indexer, none of them able to change this period's payout: ${listed(tolerated)}`)
  }
  if (blocking.length > 0) {
    throw new Error(
      `[indexer-check] registry ${registry}: ${blocking.length} item(s) active in the period are wrong in the indexer at block ${after}: ` +
        `${listed(blocking)}. A failed read the indexer cached, or an event it missed: such an item, removal or ATQ row would be ` +
        `left out unpaid. Have the indexer fixed or resynced, then rerun; or name the item in ${exclusions.path} ` +
        '({"itemID": "<id>", "scope": "all", "reason": "…"}) to leave it out of every payout and pay it by hand.'
    )
  }
  console.log(
    `[indexer-check] ${registry}: all ${events.created.length} items created on Gnosis are in the indexer, ` +
      `${compared.length} of them compared with the registry at block ${after} (state and requests)` +
      (indexed.size > compared.length ? ` (${indexed.size - compared.length} changing while read, not compared)` : "")
  )
  return after
}

const checked = new Set<string>()

// Stops the run when the indexer is behind the period, or misses or gets
// wrong any item of `registries` that is active in the period. Checked once
// per period and set of registries in a process.
export const assertIndexerComplete = async (
  period: Period,
  registries: string[],
  reader?: GnosisReader,
  exclusions: ExclusionList = loadExclusions()
): Promise<void> => {
  if (!indexerCheckEnabled()) {
    console.warn("[indexer-check] INDEXER_CHECK=off: the indexer is not checked against Gnosis")
    return
  }
  const key = `${period.end.getTime()}|${registries.join(",")}`
  if (checked.has(key)) return
  try {
    const gnosis = reader || gnosisReader()
    let progress = await indexerProgress()
    const reachedAt = await gnosis.blockTime(progress)
    const end = Math.floor(period.end.getTime() / 1000)
    if (reachedAt < end) {
      throw new Error(
        `[indexer-check] the indexer has processed Gnosis only up to block ${progress} ` +
          `(${new Date(reachedAt * 1000).toISOString()}), before the period ends (${period.end.toISOString()}): ` +
          "the items registered after that would be left out. Wait until it catches up and rerun."
      )
    }
    const start = Math.floor(period.start.getTime() / 1000)
    for (const registry of registries) progress = await checkRegistry(registry.toLowerCase(), progress, start, gnosis, exclusions)
  } catch (err) {
    if (errorMessage(err).startsWith("[indexer-check]")) throw err
    throw new Error(`[indexer-check] could not check the indexer against Gnosis (${errorMessage(err)}); rerun`)
  }
  console.log(`[indexer-check] the indexer covers the period (processed past ${period.end.toISOString()})`)
  checked.add(key)
}
