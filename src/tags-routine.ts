import { fetchTags } from "./tag-fetch"
import { EnrichedTag, FetchEnrichmentInfo, FetchManifest, Period, Tag } from "./types"
import { findChainConfig } from "./utils/chains"
import { enrichAllEvmAddresses, EvmEnrichmentResult, getEvmTxProvider } from "./utils/evm-enrichment"
import { enrichSolanaTagsBatch, getSolanaTxProvider, SolanaEnrichmentResult } from "./utils/solana-enrichment"
import { SOLANA_HOLDER_THRESHOLD } from "./utils/solana-common"
import { acquireTxCountCacheLock, txCountCacheDir, txCountCacheEnabled } from "./utils/tx-count-cache"
import { writeFetchOutputs } from "./utils/fetch-output"
import { applyTagFilters } from "./utils/tag-filters"

// Settings that would only fail once a lookup starts, checked up front so a
// typo does not surface hours later.
const preflight = (hasEvm: boolean, hasSolana: boolean): void => {
  const evmProvider = getEvmTxProvider()
  const solanaProvider = getSolanaTxProvider()
  if (hasEvm && evmProvider === "hypersync" && !String(process.env.ENVIO_API_TOKEN || "").trim()) {
    throw new Error(
      "[enrich] ENVIO_API_TOKEN is not set. Create a free token at https://envio.dev/app/api-tokens " +
        "and add ENVIO_API_TOKEN=<token> to .env (or set EVM_TX_PROVIDER=dune)."
    )
  }
  const lookback = String(process.env.SOLANA_TX_LOOKBACK_DAYS || "").trim()
  if (hasSolana && solanaProvider === "rpc" && lookback && lookback !== "0") {
    throw new Error(
      `[enrich] SOLANA_TX_LOOKBACK_DAYS=${lookback} is not supported by the rpc provider, which counts all-time. ` +
        "Set it to 0, or use SOLANA_TX_PROVIDER=dune."
    )
  }
}

// Runs both lookups to the end even if one fails, so the other one's progress
// is checkpointed and a rerun only redoes what is missing; then fails loudly.
// A failure is logged as soon as it happens, so the operator can stop early.
const runBoth = async <A, B>(a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> => {
  const errors: string[] = []
  let resultA: A | undefined
  let resultB: B | undefined
  const fail = (label: string, err: unknown) => {
    const text = `${label}: ${(err as Error)?.message || err}`
    errors.push(text)
    console.error(
      `[enrich] ${text}\n[enrich] The other lookup keeps running so its progress is saved; Ctrl+C stops it (progress is kept either way).`
    )
  }
  await Promise.all([
    a().then(
      (value) => {
        resultA = value
      },
      (err) => fail("EVM", err)
    ),
    b().then(
      (value) => {
        resultB = value
      },
      (err) => fail("Solana", err)
    ),
  ])
  if (errors.length > 0 || resultA === undefined || resultB === undefined) {
    const resume = txCountCacheEnabled()
      ? ` Progress is saved in ${txCountCacheDir()}; rerun the same command to resume.`
      : ""
    throw new Error(`[enrich] Transaction counts failed, no output was written.${resume}\n  ${errors.join("\n  ")}`)
  }
  return [resultA, resultB]
}

export const enrichTags = async (
  tags: Tag[]
): Promise<{ enrichedTags: EnrichedTag[]; droppedBySolanaHoldersCount: number; enrichment: FetchEnrichmentInfo }> => {
  const output: EnrichedTag[] = []
  let droppedBySolanaHoldersCount = 0
  const startedAt = new Date().toISOString()
  console.log(`Starting enrichment for ${tags.length} tags...`)

  const evmAddressesByChain: { [chainId: string]: string[] } = {}
  const solanaTags: Tag[] = []
  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg) continue
    if (chainCfg.namespaceId === "eip155") {
      if (!evmAddressesByChain[tag.chain]) evmAddressesByChain[tag.chain] = []
      evmAddressesByChain[tag.chain].push(tag.tagAddress)
    } else if (chainCfg.namespaceId === "solana") {
      solanaTags.push(tag)
    }
  }

  // Enrichment drives the payout split, so a lookup failure must stop the run
  // instead of silently paying on zeros.
  preflight(Object.keys(evmAddressesByChain).length > 0, solanaTags.length > 0)
  const releaseLock = acquireTxCountCacheLock()
  let results: [EvmEnrichmentResult, SolanaEnrichmentResult]
  try {
    results = await runBoth(
      () => enrichAllEvmAddresses(evmAddressesByChain),
      () => enrichSolanaTagsBatch(solanaTags)
    )
  } finally {
    releaseLock()
  }
  const [evm, solana] = results

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
      const addressLower = tag.tagAddress.trim().toLowerCase()
      const hit = (evm.byChain[tag.chain] || {})[addressLower]
      if (!hit) {
        throw new Error(`[enrich] No tx count returned for ${tag.chain}:${tag.tagAddress} (item ${tag.id})`)
      }
      base.txCount = hit.txCount
    } else {
      const cacheKey = `${tag.chain}:${tag.registry}:${tag.tagAddress}`
      const hit = solana.byKey[cacheKey]
      if (!hit) {
        throw new Error(`[enrich] No Solana data returned for ${cacheKey} (item ${tag.id})`)
      }
      base.txCount = hit.txCount
      if (tag.registry === "tokens") {
        if (hit.totalHolders === null) {
          throw new Error(`[enrich] No holder count returned for Solana token ${tag.tagAddress} (item ${tag.id})`)
        }
        if (hit.totalHolders < SOLANA_HOLDER_THRESHOLD) {
          droppedBySolanaHoldersCount++
          console.log(
            `[enrich ${progress}] skipped=${base.tagAddress} reason=solana holders ${hit.totalHolders} < ${SOLANA_HOLDER_THRESHOLD}`
          )
          continue
        }
      }
    }
    output.push(base)
  }

  return {
    enrichedTags: output,
    droppedBySolanaHoldersCount,
    enrichment: {
      startedAt,
      finishedAt: new Date().toISOString(),
      evm: evm.provenance,
      solana: solana.provenance,
    },
  }
}

export const tagsRoutine = async (period: Period): Promise<FetchManifest> => {
  console.log("Period:", period)
  preflight(true, true) // before the slow fetch + filter steps
  const tags = await fetchTags(period)
  console.log("Fetched tags:", tags.length)

  const { passed: filteredTags, excluded } = await applyTagFilters(tags)
  for (const { tag, reason } of excluded) {
    console.log(`[filter] Excluded (${reason}):`, tag.tagAddress, `| chain: ${tag.chain}`)
  }
  console.log("Tags after fetch filtering:", filteredTags.length)

  const { enrichedTags, droppedBySolanaHoldersCount, enrichment } = await enrichTags(filteredTags)
  const runId = String(new Date().getTime())
  const manifest = await writeFetchOutputs(
    runId,
    enrichedTags,
    droppedBySolanaHoldersCount,
    period,
    { excludedCount: excluded.length, enrichment }
  )

  console.log("Fetch completed:", manifest)
  return manifest
}
