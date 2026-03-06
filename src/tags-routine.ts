import { fetchTags } from "./tag-fetch"
import { EnrichedTag, FetchManifest, Period, Tag } from "./types"
import { findChainConfig } from "./utils/chains"
import { enrichAllEvmAddresses } from "./utils/evm-enrichment"
import { enrichSolanaTagsBatch } from "./utils/solana-enrichment"
import { writeFetchOutputs } from "./utils/fetch-output"
import { isTaggedOnEtherscan } from "./utils/is-tagged-on-etherscan"
import { getAddressTagExclusionReason } from "./utils/address-tag-validation"
import { sleep } from "./transaction-sender"

const SOLANA_HOLDER_THRESHOLD = 5000

const RPC_CONCURRENCY = 5

const applyFetchFilters = async (tags: Tag[]): Promise<Tag[]> => {
  // Phase 1: sync filters
  const afterFilters: Tag[] = []

  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg) {
      console.log("Chain not configured for rewards, skipping...", tag)
      continue
    }

    const isAlreadyTagged = await isTaggedOnEtherscan(
      chainCfg.explorer,
      tag.tagAddress
    )
    await sleep(2)

    if (isAlreadyTagged) {
      console.log(
        "Already tagged on explorer, skipping...",
        tag
      )
      continue
    }

    if (tag.isTokenOnAddressTags) {
      console.log("Token submitted inside Address Tag Registry, skipping...", tag)
      continue
    }

    afterFilters.push(tag)
  }

  // Phase 2: parallel RPC validation for addressTags (concurrency-limited)
  const addressTagsToValidate = afterFilters.filter(
    (tag) => tag.registry === "addressTags"
  )
  const nonAddressTags = afterFilters.filter(
    (tag) => tag.registry !== "addressTags"
  )

  // Group by chain so we don't blast a single RPC with concurrent requests
  const byChain: { [chainId: string]: Tag[] } = {}
  for (const tag of addressTagsToValidate) {
    if (!byChain[tag.chain]) byChain[tag.chain] = []
    byChain[tag.chain].push(tag)
  }

  const excludedSet = new Set<string>()
  for (const chainId of Object.keys(byChain)) {
    const chainTags = byChain[chainId]
    const chainCfg = findChainConfig(chainId)
    if (!chainCfg) continue

    for (let i = 0; i < chainTags.length; i += RPC_CONCURRENCY) {
      const chunk = chainTags.slice(i, i + RPC_CONCURRENCY)
      const results = await Promise.all(
        chunk.map(async (tag) => {
          const reason = await getAddressTagExclusionReason(tag, chainCfg)
          return { tag, reason }
        })
      )
      for (const { tag, reason } of results) {
        if (reason) {
          console.log(`[filter] Address tag not rewardable (${reason}):`, tag.tagAddress, `| chain: ${tag.chain}`)
          excludedSet.add(tag.id)
        }
      }
      if (i + RPC_CONCURRENCY < chainTags.length) {
        await sleep(1)
      }
    }
  }

  const validAddressTags = addressTagsToValidate.filter(
    (tag) => !excludedSet.has(tag.id)
  )

  return nonAddressTags.concat(validAddressTags)
}

const enrichTags = async (
  tags: Tag[]
): Promise<{ enrichedTags: EnrichedTag[]; droppedBySolanaHoldersCount: number }> => {
  const evmBatchCacheByChain: {
    [chainId: string]: { [addressLower: string]: { txCount: number } }
  } = {}
  const output: EnrichedTag[] = []
  let droppedBySolanaHoldersCount = 0
  console.log(`Starting enrichment for ${tags.length} tags...`)

  // --- EVM: single UNION ALL query across all chains ---
  const evmAddressesByChain: { [chainId: string]: string[] } = {}
  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg || chainCfg.namespaceId !== "eip155") continue
    if (!evmAddressesByChain[tag.chain]) {
      evmAddressesByChain[tag.chain] = []
    }
    evmAddressesByChain[tag.chain].push(tag.tagAddress)
  }

  try {
    const evmResults = await enrichAllEvmAddresses(evmAddressesByChain)
    for (const chainId of Object.keys(evmResults)) {
      evmBatchCacheByChain[chainId] = evmResults[chainId]
    }
  } catch (err) {
    console.warn(
      `[enrich] EVM batch lookup failed, using txCount=0 for all chains`,
      err
    )
  }

  // --- Solana: batch all tags into 2 Dune queries ---
  const solanaTags = tags.filter((tag) => {
    const chainCfg = findChainConfig(tag.chain)
    return chainCfg && chainCfg.namespaceId === "solana"
  })
  const solanaCache =
    solanaTags.length > 0 ? await enrichSolanaTagsBatch(solanaTags) : {}

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

  const filteredTags = await applyFetchFilters(tags)
  console.log("Tags after fetch filtering:", filteredTags.length)

  const { enrichedTags, droppedBySolanaHoldersCount } = await enrichTags(filteredTags)
  const runId = String(new Date().getTime())
  const manifest = await writeFetchOutputs(
    runId,
    enrichedTags,
    droppedBySolanaHoldersCount
  )

  console.log("Fetch completed:", manifest)
  return manifest
}
