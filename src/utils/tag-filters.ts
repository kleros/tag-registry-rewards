import { ChainConfig, ExplorerReview, FilterCheckReason, Period, Tag } from "../types"
import { findChainConfig } from "./chains"
import { checkExplorerTags } from "./explorer-tags"
import { getAddressTagExclusionReason } from "./address-tag-validation"
import { detectPredictionMarketTokens } from "./prediction-market-detection"
import { sleep } from "../transaction-sender"

// The prediction-market filter applies to periods starting on or after this
// date (YYYY-MM-DD, UTC): the rule was announced for the October 2026 period, so
// re-running an older month reproduces what was paid. Override with
// PREDICTION_MARKET_FILTER_SINCE (e.g. 2000-01-01 to apply it to every period).
// Parsed once at load so a typo fails at startup, not after the subgraph fetch.
const PREDICTION_MARKET_POLICY_START = "2026-10-01"
const PREDICTION_MARKET_FILTER_SINCE = process.env.PREDICTION_MARKET_FILTER_SINCE || PREDICTION_MARKET_POLICY_START
const parseFilterSince = (raw: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw new Error(`Invalid PREDICTION_MARKET_FILTER_SINCE "${raw}". Expected YYYY-MM-DD.`)
  }
  const since = new Date(`${raw.trim()}T00:00:00Z`)
  // Date would roll 2026-02-30 over to March 2: compare the parts back.
  if (isNaN(since.getTime()) || since.toISOString().slice(0, 10) !== raw.trim()) {
    throw new Error(`Invalid PREDICTION_MARKET_FILTER_SINCE "${raw}": not a real date.`)
  }
  return since
}
const predictionMarketFilterSince = parseFilterSince(PREDICTION_MARKET_FILTER_SINCE)

const predictionMarketFilterApplies = (period?: Period): boolean => {
  if (!period) return true
  const applies = period.start.getTime() >= predictionMarketFilterSince.getTime()
  if (!applies) {
    console.log(
      `[filter] Prediction-market filter skipped: period starts ${period.start.toISOString()}, ` +
        `before PREDICTION_MARKET_FILTER_SINCE=${PREDICTION_MARKET_FILTER_SINCE}`
    )
  }
  return applies
}

export interface FilterResult {
  passed: Tag[]
  excluded: { tag: Tag; reason: FilterCheckReason; detail?: string }[]
  // What the reference explorers show of the Address Tags and Tokens entries,
  // for review: nothing is excluded for it automatically (reviewOnExplorer)
  explorerReview: ExplorerReview[]
}

export interface TagFilterOptions {
  // The reward period the tags are filtered for.
  period?: Period
  rpcConcurrency?: number
  // prefetch: only counting transactions, the explorers are left alone
  skipExplorerCheck?: boolean
}

// EXPLORER_CHECK=off skips the explorer check (then every entry is to be
// checked by hand, with exclusions.json for the tagged ones).
export const explorerCheckEnabled = (): boolean =>
  !/^(off|false|0|no)$/i.test(String(process.env.EXPLORER_CHECK || "").trim())

export const applyTagFilters = async (
  tags: Tag[],
  options: TagFilterOptions = {}
): Promise<FilterResult> => {
  const { period, rpcConcurrency = 5, skipExplorerCheck = false } = options

  const passed: Tag[] = []
  const excluded: FilterResult["excluded"] = []
  let explorerReview: ExplorerReview[] = []

  // Phase 1: the rules that need no network
  const afterPhase1: Tag[] = []
  for (const tag of tags) {
    if (!findChainConfig(tag.chain)) {
      excluded.push({ tag, reason: "chain not configured for rewards" })
      continue
    }
    if (tag.isTokenOnAddressTags) {
      excluded.push({ tag, reason: "token on address tags" })
      continue
    }
    afterPhase1.push(tag)
  }

  // Phase 1b: prediction-market outcome tokens are not rewarded (Tokens
  // registry only, from the October 2026 period; purely on-chain detection,
  // batched per chain via Multicall3; an RPC that fails stops the run)
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

  // Phase 3: what the chains' reference explorers show of the entries left
  // (for review; the ones excluded above need none)
  if (!explorerCheckEnabled()) {
    console.log("[filter] EXPLORER_CHECK=off: no entry looked up on its explorer (check them by hand)")
  } else if (!skipExplorerCheck) {
    explorerReview = await reviewOnExplorer(afterPhase1b.filter((tag) => !excludedSet.has(tag.id)))
  }

  return { passed, excluded, explorerReview }
}

// Address Tags and Tokens entries already tagged on their chain's reference
// explorer are not rewarded; Contract Domain Name entries are exempt (the
// program's rules). Each such entry is looked up, and those tagged there, or
// whose explorer could not be read, are returned for review. None is excluded
// here: an explorer shows its tags as they are today, not when they were added
// (the rule is about tags that predate the submission), and Etherscan-built
// explorers do not say whether a tag came from Kleros Scout itself (Blockscout
// does, and those are left out). A confirmed one goes to exclusions.json.
export const reviewOnExplorer = async (tags: Tag[]): Promise<ExplorerReview[]> => {
  const checked = tags.filter((tag) => tag.registry !== "domains")
  const hostOf = (tag: Tag): string => (findChainConfig(tag.chain) as ChainConfig).explorer
  const results = await checkExplorerTags(
    checked.map((tag, i) => ({ key: String(i), host: hostOf(tag), chainId: tag.chain, address: tag.tagAddress }))
  )
  const review: ExplorerReview[] = []
  const notRead: { [host: string]: number } = {}
  checked.forEach((tag, i) => {
    const verdict = results.get(String(i))
    if (!verdict || verdict.tagged === false) return
    if (verdict.tagged === true) {
      review.push({ tag, status: "tagged", url: verdict.url, detail: `${hostOf(tag)}: ${verdict.names.join("; ")}` })
    } else {
      review.push({ tag, status: "not read", url: verdict.url, detail: verdict.detail })
      notRead[hostOf(tag)] = (notRead[hostOf(tag)] || 0) + 1
    }
  })
  const tagged = review.filter((r) => r.status === "tagged").length
  const notReadText = Object.keys(notRead)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((host) => `${host} ${notRead[host]}`)
    .join(", ")
  console.log(
    `[filter] Explorer check: ${checked.length} Address Tags and Tokens entries looked up, ${tagged} tagged on their explorer` +
      (review.length > tagged ? `, ${review.length - tagged} on explorers that cannot be read (${notReadText})` : "") +
      (review.length > 0 ? ": review them (nothing is excluded for it automatically)" : "")
  )
  return review
}
