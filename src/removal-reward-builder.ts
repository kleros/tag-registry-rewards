import { BigNumber } from "ethers"
import conf from "./config"
import { Removal, RemovalReward, Tag } from "./types"
import { humanizeAmount } from "./transaction-sender"
import { parseWei } from "./utils/parse-wei"

type RegistryKey = Tag["registry"]

type RemovalRegistryConfig = {
  rewardPool: BigNumber
  maxPerRemoval: BigNumber
}

const getRemovalConfig = (): Record<RegistryKey, RemovalRegistryConfig> => ({
  addressTags: {
    rewardPool: parseWei(
      "REMOVAL_REWARD_POOL_ADDRESS_TAGS",
      conf.REMOVAL_REWARD_POOL_ADDRESS_TAGS
    ),
    maxPerRemoval: parseWei(
      "REMOVAL_MAX_PER_REMOVAL_ADDRESS_TAGS",
      conf.REMOVAL_MAX_PER_REMOVAL_ADDRESS_TAGS
    ),
  },
  tokens: {
    rewardPool: parseWei(
      "REMOVAL_REWARD_POOL_TOKENS",
      conf.REMOVAL_REWARD_POOL_TOKENS
    ),
    maxPerRemoval: parseWei(
      "REMOVAL_MAX_PER_REMOVAL_TOKENS",
      conf.REMOVAL_MAX_PER_REMOVAL_TOKENS
    ),
  },
  domains: {
    rewardPool: parseWei(
      "REMOVAL_REWARD_POOL_DOMAINS",
      conf.REMOVAL_REWARD_POOL_DOMAINS
    ),
    maxPerRemoval: parseWei(
      "REMOVAL_MAX_PER_REMOVAL_DOMAINS",
      conf.REMOVAL_MAX_PER_REMOVAL_DOMAINS
    ),
  },
})

// Deduplicate removals within a registry by tagged address + chain, keeping the
// most recent removal, so the same item removed twice in a period counts once.
const dedupeRemovals = (removals: Removal[]): Removal[] => {
  const bag = new Map<string, Removal>()
  for (const removal of removals) {
    const key = removal.tagAddress
      ? `${removal.tagAddress.toLowerCase()}|${(removal.chain || "unknown").toLowerCase()}`
      : removal.id.toLowerCase()
    const existing = bag.get(key)
    if (!existing || existing.removedAt < removal.removedAt) {
      bag.set(key, removal)
    }
  }
  return Array.from(bag.values())
}

// Flat reward per registry: each remover gets min(pool / removals, cap).
// No recursive redistribution of the capped leftover (one-pass cap).
export const buildRemovalRewards = (removals: Removal[]): RemovalReward[] => {
  const config = getRemovalConfig()
  const registries: RegistryKey[] = ["addressTags", "tokens", "domains"]
  const rewards: RemovalReward[] = []

  for (const registry of registries) {
    const registryRemovals = dedupeRemovals(
      removals.filter((r) => r.registry === registry)
    )
    const count = registryRemovals.length
    if (count === 0) continue

    const { rewardPool, maxPerRemoval } = config[registry]
    const perRemovalRaw = rewardPool.div(BigNumber.from(count))
    const perRemoval = perRemovalRaw.gt(maxPerRemoval)
      ? maxPerRemoval
      : perRemovalRaw

    console.log(
      `[removals] ${registry}: ${count} removals, ${humanizeAmount(
        perRemoval
      )} PNK each (pool ${humanizeAmount(rewardPool)}, cap ${humanizeAmount(
        maxPerRemoval
      )})`
    )

    for (const removal of registryRemovals) {
      rewards.push({
        removal,
        amount: perRemoval,
        recipient: removal.submitter,
        id: removal.id,
      })
    }
  }

  return rewards
}
