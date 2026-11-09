import { utils } from "ethers"
import fetch from "node-fetch"
import conf from "../config"
import { Period } from "../types"
import { hypersyncUrl, loadHypersync, requireEnvioApiToken } from "./hypersync-enrichment"
import { errorMessage } from "./runtime-helpers"

// The indexer (XDAI_GTCR_SUBGRAPH_URL) is the only place the registries are
// read from, and every item it leaves out of a period is silently unpaid while
// its share goes to the others. Besides blank items (item-data.ts), it can
// leave items out in two ways, both checked here against Gnosis itself before
// a run reads it:
// - it has not processed the end of the period yet: the last days' items are
//   still "requested", not registered (an indexer behind or stuck);
// - it never stored an item at all (an event it missed): every item a
//   registry ever created on-chain (its NewItem events) must be in the indexer.
// INDEXER_CHECK=off skips both (the tests do, having no Gnosis to ask).

const GNOSIS = "100"
const NEW_ITEM = utils.id("NewItem(bytes32,string,bool)")
const PAGE_SIZE = 1000

export const indexerCheckEnabled = (): boolean =>
  !/^(off|false|0|no)$/i.test(String(process.env.INDEXER_CHECK || "").trim())

// What a check reads from Gnosis: a block's time, and every itemID a registry
// created (NewItem) in blocks below `toBlock`.
export interface GnosisReader {
  blockTime(block: number): Promise<number>
  createdItemIds(registry: string, toBlock: number): Promise<string[]>
}

const hypersyncReader = (): GnosisReader => {
  const hs = loadHypersync()
  const client = new hs.HypersyncClient({ url: hypersyncUrl(GNOSIS), apiToken: requireEnvioApiToken(), maxNumRetries: 20 })
  return {
    blockTime: async (block) => {
      const res = await client.get({ fromBlock: block, toBlock: block + 1, includeAllBlocks: true, fieldSelection: { block: ["Number", "Timestamp"] } })
      const found = (res.data.blocks || []).find((b: { number: number }) => Number(b.number) === block)
      if (!found) throw new Error(`HyperSync has no block ${block} on Gnosis`)
      return Number(found.timestamp)
    },
    createdItemIds: async (registry, toBlock) => {
      const ids = new Set<string>()
      let fromBlock = 0
      while (fromBlock < toBlock) {
        const res = await client.get({ fromBlock, toBlock, logs: [{ address: [registry], topics: [[NEW_ITEM]] }], fieldSelection: { log: ["Topic0", "Topic1"] } })
        for (const log of res.data.logs || []) if (log.topics && log.topics[1]) ids.add(String(log.topics[1]).toLowerCase())
        if (!(res.nextBlock > fromBlock)) throw new Error(`HyperSync did not move past block ${fromBlock}`)
        fromBlock = res.nextBlock
      }
      return Array.from(ids)
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

const indexedItemIds = async (registry: string): Promise<Set<string>> => {
  const ids = new Set<string>()
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const data = await query(
      `{ litems:LItem(where: { registryAddress: {_eq:"${registry}"} }, limit: ${PAGE_SIZE}, offset: ${offset}, order_by: {id: asc}) { itemID } }`
    )
    const page: { itemID: string }[] = data.litems || []
    for (const item of page) ids.add(String(item.itemID).toLowerCase())
    if (page.length < PAGE_SIZE) return ids
  }
}

const checked = new Set<string>()

// Stops the run when the indexer is behind the period or misses any item of
// `registries`. Checked once per period and set of registries in a process.
export const assertIndexerComplete = async (
  period: Period,
  registries: string[],
  reader?: GnosisReader
): Promise<void> => {
  if (!indexerCheckEnabled()) {
    console.warn("[indexer-check] INDEXER_CHECK=off: the indexer is not checked against Gnosis")
    return
  }
  const key = `${period.end.getTime()}|${registries.join(",")}`
  if (checked.has(key)) return
  const gnosis = reader || hypersyncReader()
  try {
    const progress = await indexerProgress()
    const reachedAt = await gnosis.blockTime(progress)
    const end = Math.floor(period.end.getTime() / 1000)
    if (reachedAt < end) {
      throw new Error(
        `[indexer-check] the indexer has processed Gnosis only up to block ${progress} ` +
          `(${new Date(reachedAt * 1000).toISOString()}), before the period ends (${period.end.toISOString()}): ` +
          "the items registered after that would be left out. Wait until it catches up and rerun."
      )
    }
    for (const registry of registries) {
      const [created, indexed] = await Promise.all([gnosis.createdItemIds(registry.toLowerCase(), progress + 1), indexedItemIds(registry.toLowerCase())])
      const missing = created.filter((id) => !indexed.has(id))
      if (missing.length > 0) {
        throw new Error(
          `[indexer-check] registry ${registry}: ${missing.length} item(s) created on Gnosis are not in the indexer ` +
            `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). They would be left out unpaid: ` +
            "have the indexer fixed or resynced, then rerun."
        )
      }
      console.log(`[indexer-check] ${registry}: all ${created.length} items created on Gnosis are in the indexer`)
    }
  } catch (err) {
    if (/^\[indexer-check\]/.test(errorMessage(err))) throw err
    throw new Error(`[indexer-check] could not check the indexer against Gnosis (${errorMessage(err)}); rerun`)
  }
  console.log(`[indexer-check] the indexer covers the period (processed past ${period.end.toISOString()})`)
  checked.add(key)
}
