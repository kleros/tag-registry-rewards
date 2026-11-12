import { ChainConfig, ExplorerReview, FilterCheckReason, Period, Tag } from "../types"
import { findChainConfig } from "./chains"
import { checkExplorerTags } from "./explorer-tags"
import { dateExplorerTags, DatingItem } from "./tag-dating"
import { registrationLookup } from "../tag-fetch"
import { getAddressTagExclusionReason } from "./address-tag-validation"
import { detectPredictionMarketTokens } from "./prediction-market-detection"
import { sleep } from "../transaction-sender"

// A YYYY-MM-DD (UTC) setting, parsed once at load so a typo fails at startup,
// not after the subgraph fetch.
const parseSinceDate = (setting: string, raw: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw new Error(`Invalid ${setting} "${raw}". Expected YYYY-MM-DD.`)
  }
  const since = new Date(`${raw.trim()}T00:00:00Z`)
  // Date would roll 2026-02-30 over to March 2: compare the parts back.
  if (isNaN(since.getTime()) || since.toISOString().slice(0, 10) !== raw.trim()) {
    throw new Error(`Invalid ${setting} "${raw}": not a real date.`)
  }
  return since
}

// The prediction-market filter applies to periods starting on or after this
// date (YYYY-MM-DD, UTC): the rule was announced for the October 2026 period, so
// re-running an older month reproduces what was paid. Override with
// PREDICTION_MARKET_FILTER_SINCE (e.g. 2000-01-01 to apply it to every period).
const PREDICTION_MARKET_POLICY_START = "2026-10-01"
const PREDICTION_MARKET_FILTER_SINCE = process.env.PREDICTION_MARKET_FILTER_SINCE || PREDICTION_MARKET_POLICY_START
const predictionMarketFilterSince = parseSinceDate("PREDICTION_MARKET_FILTER_SINCE", PREDICTION_MARKET_FILTER_SINCE)

// The explorer check excludes, on dated evidence (utils/tag-dating.ts), from
// the periods starting on or after this date: the November 2026 period was
// the first paid this way, so re-running an older month reproduces what was
// paid (its tagged entries are only listed for review). Override with
// EXPLORER_DATING_SINCE, read when a period is filtered (and checked at load,
// so a typo still fails at startup).
const EXPLORER_DATING_POLICY_START = "2026-11-01"
const explorerDatingSetting = (): string => process.env.EXPLORER_DATING_SINCE || EXPLORER_DATING_POLICY_START
parseSinceDate("EXPLORER_DATING_SINCE", explorerDatingSetting())

export const explorerDatingApplies = (period?: Period): boolean =>
  !period || period.start.getTime() >= parseSinceDate("EXPLORER_DATING_SINCE", explorerDatingSetting()).getTime()

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
  // What the reference explorers show of the Address Tags and Tokens entries
  // (tagged there, or not readable), each with the dated check's verdict when
  // it applies (reviewOnExplorer)
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
  // (the ones excluded above need no look-up): from the periods the dated
  // check applies to, an entry with dated evidence of its tag before its
  // submission is excluded, the others listed with their verdict.
  const datedOut = new Set<string>()
  if (!explorerCheckEnabled()) {
    console.log("[filter] EXPLORER_CHECK=off: no entry looked up on its explorer (check them by hand)")
  } else if (!skipExplorerCheck) {
    explorerReview = await reviewOnExplorer(afterPhase1b.filter((tag) => !excludedSet.has(tag.id)), period)
    for (const review of explorerReview) {
      if (review.decision !== "excluded") continue
      excluded.push({ tag: review.tag, reason: "tagged on explorer before submission", detail: review.evidence })
      datedOut.add(review.tag.id)
    }
  }

  return { passed: passed.filter((tag) => !datedOut.has(tag.id)), excluded, explorerReview }
}

// Address Tags and Tokens entries already tagged on their chain's reference
// explorer when they were submitted are not rewarded; Contract Domain Name
// entries are exempt (the program's rules). Each such entry is looked up, and
// those tagged there today, or whose explorer could not be read, are returned.
// An explorer shows its tags as they are today, not when they were added, so
// from the periods the dated check applies to (explorerDatingApplies), each is
// dated by tag-dating.ts: excluded only on dated evidence that its tag existed
// before the submission, paid without any. Before those periods they are only
// listed, for a check by hand (a confirmed one goes to exclusions.json). Tags
// an explorer took from Kleros Scout never count (explorer-tags.ts).
export const reviewOnExplorer = async (tags: Tag[], period?: Period): Promise<ExplorerReview[]> => {
  const checked = tags.filter((tag) => tag.registry !== "domains")
  const hostOf = (tag: Tag): string => (findChainConfig(tag.chain) as ChainConfig).explorer
  const results = await checkExplorerTags(
    checked.map((tag, i) => ({ key: String(i), host: hostOf(tag), chainId: tag.chain, address: tag.tagAddress }))
  )
  const review: ExplorerReview[] = []
  const namesOf: string[][] = [] // each review's tags, as read
  const notRead: { [host: string]: number } = {}
  checked.forEach((tag, i) => {
    const verdict = results.get(String(i))
    if (!verdict || verdict.tagged === false) return
    const shown = {
      ...(verdict.logo ? { logo: verdict.logo } : {}),
      ...(verdict.createdAt !== undefined ? { createdAt: verdict.createdAt } : {}),
    }
    namesOf.push(verdict.names)
    if (verdict.tagged === true) {
      review.push({ tag, status: "tagged", url: verdict.url, detail: `${hostOf(tag)}: ${verdict.names.join("; ")}`, ...shown })
    } else {
      review.push({ tag, status: "not read", url: verdict.url, detail: verdict.detail, ...shown })
      notRead[hostOf(tag)] = (notRead[hostOf(tag)] || 0) + 1
    }
  })
  const tagged = review.filter((r) => r.status === "tagged").length
  const notReadText = Object.keys(notRead)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((host) => `${host} ${notRead[host]}`)
    .join(", ")
  const found =
    `[filter] Explorer check: ${checked.length} Address Tags and Tokens entries looked up, ${tagged} tagged on their explorer` +
    (review.length > tagged ? `, ${review.length - tagged} on explorers that cannot be read (${notReadText})` : "")

  if (!explorerDatingApplies(period)) {
    console.log(found + (review.length > 0 ? ": review them (nothing is excluded for it automatically)" : ""))
    console.log(
      `[filter] Explorer dating skipped: period starts ${(period as Period).start.toISOString()}, ` +
        `before EXPLORER_DATING_SINCE=${explorerDatingSetting()}`
    )
    return review
  }
  if (review.length === 0) {
    console.log(found)
    return review
  }
  console.log(`${found}: dating them (Wayback Machine, token logos, eth-labels)`)
  const registrations = registrationLookup()
  // A tag an explorer took from an earlier Kleros entry of the address never counts.
  const earlierKlerosEntry = async (item: DatingItem, before: number): Promise<string | null> => {
    try {
      const earlier = (await registrations(item.chainId, item.address)).find((r) => r.resolvedAt < before)
      return earlier
        ? `Kleros entry ${earlier.id} registered this address on ${new Date(earlier.resolvedAt * 1000).toISOString()}, ` +
            "and a tag an explorer took from Kleros never counts"
        : null
    } catch (err) {
      return `the program's registries could not be checked for an earlier entry of this address (${String((err as Error).message || err).slice(0, 120)})`
    }
  }
  const verdicts = await dateExplorerTags(
    review.map((r, i) => ({
      key: String(i),
      host: hostOf(r.tag),
      chainId: r.tag.chain,
      address: r.tag.tagAddress,
      ...(r.tag.submissionTime ? { submissionTime: r.tag.submissionTime } : {}),
      tagged: r.status === "tagged" ? true : null,
      names: namesOf[i],
      ...(r.logo ? { logo: r.logo } : {}),
      ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
    })),
    { earlierKlerosEntry }
  )
  review.forEach((r, i) => {
    const verdict = verdicts.get(String(i))
    if (!verdict) throw new Error(`[filter] the dated explorer check gave no verdict for ${r.tag.id}`)
    r.decision = verdict.decision
    r.evidence = verdict.evidence
  })
  const count = (decision: ExplorerReview["decision"]): number => review.filter((r) => r.decision === decision).length
  console.log(
    `[filter] Explorer dating: ${count("excluded")} excluded on dated evidence of a tag before their submission, ` +
      `${count("kept")} kept on dated evidence, ${count("paid by default")} paid without dated evidence either way`
  )
  const unchecked = review.filter(datedUnchecked).length
  if (unchecked > 0) {
    console.warn(
      `[filter] Explorer dating: ${unchecked} of them could not be checked against the Wayback Machine or the registries ` +
        "(their evidence says why): running fetch again later may exclude more"
    )
  }
  return review
}

// An entry paid by default because the Wayback Machine did not answer, refused
// the run's requests or ran out of time, or the registries could not be read
// for an earlier Kleros entry: one a later run may decide otherwise.
export const datedUnchecked = (review: ExplorerReview): boolean =>
  review.decision === "paid by default" && /the Wayback Machine|could not be checked/.test(review.evidence || "")
