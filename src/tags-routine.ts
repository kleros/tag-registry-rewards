import { fetchTags } from "./tag-fetch"
import { EnrichedTag, FetchManifest, Period, Tag } from "./types"
import { findChainConfig } from "./utils/chains"
import { enrichAllEvmAddresses } from "./utils/evm-enrichment"
import { enrichSolanaTagsBatch } from "./utils/solana-enrichment"
import { writeFetchOutputs } from "./utils/fetch-output"
import { applyTagFilters } from "./utils/tag-filters"

const SOLANA_HOLDER_THRESHOLD = 5000

const enrichTags = async (
  tags: Tag[]
): Promise<{ enrichedTags: EnrichedTag[]; droppedBySolanaHoldersCount: number }> => {
  const evmBatchCacheByChain: {
    [chainId: string]: { [addressLower: string]: { txCount: number } }
  } = {}
  const output: EnrichedTag[] = []
  let droppedBySolanaHoldersCount = 0
  console.log(`Starting enrichment for ${tags.length} tags...`)

  // --- EVM: one Dune query per chain ---
  const evmAddressesByChain: { [chainId: string]: string[] } = {}
  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg || chainCfg.namespaceId !== "eip155") continue
    if (!evmAddressesByChain[tag.chain]) {
      evmAddressesByChain[tag.chain] = []
    }
    evmAddressesByChain[tag.chain].push(tag.tagAddress)
  }

  // Enrichment drives the payout split, so a lookup failure must stop the run
  // rather than quietly reprice every affected submission as zero-traffic.
  const evmResults = await enrichAllEvmAddresses(evmAddressesByChain)
  for (const chainId of Object.keys(evmResults)) {
    evmBatchCacheByChain[chainId] = evmResults[chainId]
  }

  // --- Solana: batched Dune queries ---
  const solanaTags = tags.filter((tag) => {
    const chainCfg = findChainConfig(tag.chain)
    return chainCfg && chainCfg.namespaceId === "solana"
  })
  let solanaCache: Awaited<ReturnType<typeof enrichSolanaTagsBatch>> = {}
  if (solanaTags.length > 0) {
    solanaCache = await enrichSolanaTagsBatch(solanaTags)
  }

  // --- Assemble enriched tags ---
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    const progress = `${index + 1}/${tags.length}`
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg) continue
    if (index === 0 || (index + 1) % 10 === 0 || index === tags.length - 1) {
      console.log(
        `[enrich ${progress}] registry=${tag.registry} chain=${chainCfg.id} address=${tag.tagAddress}`
      )
    }

    const chainCaip2 = `${chainCfg.namespaceId}:${chainCfg.id}`
    const base: EnrichedTag = {
      ...tag,
      chainCaip2,
      namespaceId: chainCfg.namespaceId,
      txCount: 0,
    }

    if (chainCfg.namespaceId === "eip155") {
      const addressLower = tag.tagAddress.toLowerCase()
      const chainBatch = evmBatchCacheByChain[tag.chain] || {}
      base.txCount = (chainBatch[addressLower] || { txCount: 0 }).txCount
    } else {
      const cacheKey = `${tag.chain}:${tag.registry}:${tag.tagAddress}`
      const cached = solanaCache[cacheKey] || { txCount: 0, totalHolders: null }
      base.txCount = cached.txCount
      const totalHolders = cached.totalHolders
      if (
        tag.registry === "tokens" &&
        totalHolders !== null &&
        totalHolders < SOLANA_HOLDER_THRESHOLD
      ) {
        droppedBySolanaHoldersCount++
        console.log(
          `[enrich ${progress}] skipped=${base.tagAddress} reason=solana holders < ${SOLANA_HOLDER_THRESHOLD}`
        )
        continue
      }
    }
    output.push(base)
  }

  return { enrichedTags: output, droppedBySolanaHoldersCount }
}

export const tagsRoutine = async (period: Period): Promise<FetchManifest> => {
  console.log("Period:", period)
  const tags = await fetchTags(period)
  console.log("Fetched tags:", tags.length)

  const { passed: filteredTags, excluded } = await applyTagFilters(tags)
  for (const { tag, reason } of excluded) {
    console.log(`[filter] Excluded (${reason}):`, tag.tagAddress, `| chain: ${tag.chain}`)
  }
  console.log("Tags after fetch filtering:", filteredTags.length)

  const { enrichedTags, droppedBySolanaHoldersCount } = await enrichTags(filteredTags)
  const runId = String(new Date().getTime())
  const manifest = await writeFetchOutputs(
    runId,
    enrichedTags,
    droppedBySolanaHoldersCount,
    period
  )

  console.log("Fetch completed:", manifest)
  return manifest
}
