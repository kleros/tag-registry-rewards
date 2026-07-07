import { BigNumber } from "ethers"
import conf from "./config"
import { AtqReward, AtqRow } from "./types"
import { humanizeAmount } from "./transaction-sender"

const parseWei = (key: string, raw: string): BigNumber => {
  try {
    const value = BigNumber.from(raw.trim())
    if (value.isNegative()) throw new Error("negative")
    return value
  } catch {
    throw new Error(`Invalid ${key}="${raw}". Expected a non-negative integer (wei).`)
  }
}

// Flat, capped ATQ reward: every rewardable ATQ event (a registration or a
// removal in the ATQ registry) gets min(pool / events, cap). One shared pool,
// registered and removed events counted together. No redistribution.
export const buildAtqRewards = (
  registered: AtqRow[],
  absent: AtqRow[]
): AtqReward[] => {
  const events: Array<{ row: AtqRow; kind: "registered" | "removed" }> = [
    ...registered.map((row) => ({ row, kind: "registered" as const })),
    ...absent.map((row) => ({ row, kind: "removed" as const })),
  ].filter((e) => e.row.requester && e.row.requester.length > 0)

  const count = events.length
  if (count === 0) return []

  const rewardPool = parseWei("REWARD_POOL_ATQ", conf.REWARD_POOL_ATQ)
  const maxPerAtq = parseWei("MAX_PER_ATQ", conf.MAX_PER_ATQ)
  const perEventRaw = rewardPool.div(BigNumber.from(count))
  const perEvent = perEventRaw.gt(maxPerAtq) ? maxPerAtq : perEventRaw

  console.log(
    `[atq] ${count} rewardable events, ${humanizeAmount(perEvent)} PNK each ` +
      `(pool ${humanizeAmount(rewardPool)}, cap ${humanizeAmount(maxPerAtq)})`
  )

  return events.map(({ row, kind }) => ({
    recipient: row.requester,
    id: `${row.itemID}:${kind}`,
    kind,
    itemID: row.itemID,
    metadata: row.metadata,
    amount: perEvent,
  }))
}
