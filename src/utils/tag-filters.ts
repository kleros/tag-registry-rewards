import { FilterCheckReason, Tag } from "../types"
import { findChainConfig } from "./chains"
import { isTaggedOnEtherscan } from "./is-tagged-on-etherscan"
import { getAddressTagExclusionReason } from "./address-tag-validation"
import { sleep } from "../transaction-sender"

export interface FilterResult {
  passed: Tag[]
  excluded: { tag: Tag; reason: FilterCheckReason }[]
}

export const applyTagFilters = async (
  tags: Tag[],
  rpcConcurrency = 5
): Promise<FilterResult> => {

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

  // Phase 2: parallel RPC validation for addressTags (concurrency-limited)
  const addressTagsToValidate = afterPhase1.filter(
    (tag) => tag.registry === "addressTags"
  )
  const nonAddressTags = afterPhase1.filter(
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
