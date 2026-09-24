import { FilterCheckReason, Period, Tag } from "../types"
import { findChainConfig } from "./chains"
import { isTaggedOnEtherscan } from "./is-tagged-on-etherscan"
import { getAddressTagExclusionReason } from "./address-tag-validation"
import { detectPredictionMarketTokens } from "./prediction-market-detection"
import { sleep } from "../transaction-sender"

export interface FilterResult {
  passed: Tag[]
  excluded: { tag: Tag; reason: FilterCheckReason; detail?: string }[]
}

// Optional: only apply the prediction-market filter to periods starting on or
// after this date (YYYY-MM-DD, UTC). Unset = every period, like exclusions.json.
// Parsed once at load so a typo fails at startup, not after the subgraph fetch.
const PREDICTION_MARKET_FILTER_SINCE = process.env.PREDICTION_MARKET_FILTER_SINCE
const parseFilterSince = (raw?: string): Date | null => {
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw new Error(`Invalid PREDICTION_MARKET_FILTER_SINCE "${raw}". Expected YYYY-MM-DD.`)
  }
  const since = new Date(`${raw.trim()}T00:00:00Z`)
  if (isNaN(since.getTime())) {
    throw new Error(`Invalid PREDICTION_MARKET_FILTER_SINCE "${raw}": not a real date.`)
  }
  return since
}
const predictionMarketFilterSince = parseFilterSince(PREDICTION_MARKET_FILTER_SINCE)

const predictionMarketFilterApplies = (period?: Period): boolean => {
  const since = predictionMarketFilterSince
  if (!since || !period) return true
  const applies = period.start.getTime() >= since.getTime()
  if (!applies) {
    console.log(
      `[filter] Prediction-market filter skipped: period starts ${period.start.toISOString()}, ` +
        `before PREDICTION_MARKET_FILTER_SINCE=${PREDICTION_MARKET_FILTER_SINCE}`
    )
  }
  return applies
}

export interface TagFilterOptions {
  // The reward period, used by the optional PREDICTION_MARKET_FILTER_SINCE gate.
  period?: Period
  rpcConcurrency?: number
}

export const applyTagFilters = async (
  tags: Tag[],
  options: TagFilterOptions = {}
): Promise<FilterResult> => {
  const { period, rpcConcurrency = 5 } = options

  const passed: Tag[] = []
  const excluded: FilterResult["excluded"] = []

  // Phase 1: sync filters + explorer check
  const afterPhase1: Tag[] = []

  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg) {
      excluded.push({ tag, reason: "chain not configured for rewards" })
      continue
    }

    const isAlreadyTagged = await isTaggedOnEtherscan(
      chainCfg.explorer,
      tag.tagAddress
    )
    await sleep(2)

    if (isAlreadyTagged) {
      excluded.push({ tag, reason: "already tagged on explorer" })
      continue
    }

    if (tag.isTokenOnAddressTags) {
      excluded.push({ tag, reason: "token on address tags" })
      continue
    }

    afterPhase1.push(tag)
  }

  // Phase 1b: prediction-market outcome tokens are not rewarded (Tokens
  // registry only; purely on-chain detection, batched per chain via Multicall3).
  const tokenTags = predictionMarketFilterApplies(period)
    ? afterPhase1.filter((tag) => tag.registry === "tokens")
    : []
  const predictionMarketMatches =
    tokenTags.length > 0 ? await detectPredictionMarketTokens(tokenTags) : {}
  const afterPhase1b: Tag[] = []
  for (const tag of afterPhase1) {
    const match = predictionMarketMatches[tag.id]
    if (match) {
      excluded.push({
        tag,
        reason: "prediction market outcome token",
        detail: `${match.protocol}: ${match.detail}`,
      })
      continue
    }
    afterPhase1b.push(tag)
  }

  // Phase 2: parallel RPC validation for addressTags (concurrency-limited)
  const addressTagsToValidate = afterPhase1b.filter(
    (tag) => tag.registry === "addressTags"
  )
  const nonAddressTags = afterPhase1b.filter(
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

    for (let i = 0; i < chainTags.length; i += rpcConcurrency) {
      const chunk = chainTags.slice(i, i + rpcConcurrency)
      const results = await Promise.all(
        chunk.map(async (tag) => {
          const reason = await getAddressTagExclusionReason(tag, chainCfg)
          return { tag, reason }
        })
      )
      for (const { tag, reason } of results) {
        if (reason) {
          excluded.push({ tag, reason })
          excludedSet.add(tag.id)
        }
      }
      if (i + rpcConcurrency < chainTags.length) {
        await sleep(1)
      }
    }
  }

  const validAddressTags = addressTagsToValidate.filter(
    (tag) => !excludedSet.has(tag.id)
  )

  passed.push(...nonAddressTags, ...validAddressTags)

  return { passed, excluded }
}
