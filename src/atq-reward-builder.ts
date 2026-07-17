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

// Each ATQ kind (registrations vs removals) has its own pool and cap, computed
// independently: every event of a kind gets min(pool / count, cap). This mirrors
// the historical practice where the submissions pool is fully distributed among
// registrations (e.g. 60k PNK/month) while removals earn a flat capped amount
// (500 PNK each) on top — a single shared pool cannot produce both.
const rewardKind = (
  rows: AtqRow[],
  kind: "registered" | "removed",
  rewardPool: BigNumber,
  maxPerEvent: BigNumber
): AtqReward[] => {
  const events = rows.filter((r) => r.requester && r.requester.length > 0)
  const dropped = rows.length - events.length
  if (dropped > 0) {
    console.warn(
      `[atq] WARNING: ${dropped} ${kind} row(s) have no requester (subgraph gap?) ` +
        "and were dropped — those recipients get nothing (their share is " +
        "redistributed only while the per-event cap isn't binding; otherwise " +
        "it simply goes unspent). Investigate before sending/publishing."
    )
  }
  const count = events.length
  if (count === 0) return []

  const perEventRaw = rewardPool.div(BigNumber.from(count))
  const perEvent = perEventRaw.gt(maxPerEvent) ? maxPerEvent : perEventRaw

  console.log(
    `[atq] ${kind}: ${count} events, ${humanizeAmount(perEvent)} PNK each ` +
      `(pool ${humanizeAmount(rewardPool)}, cap ${humanizeAmount(maxPerEvent)})`
  )

  return events.map((row) => ({
    recipient: row.requester,
    id: `${row.itemID}:${kind}`,
    kind,
    itemID: row.itemID,
    metadata: row.metadata,
    amount: perEvent,
  }))
}

export const buildAtqRewards = (
  registered: AtqRow[],
  absent: AtqRow[]
): AtqReward[] => [
  ...rewardKind(
    registered,
    "registered",
    parseWei("REWARD_POOL_ATQ_SUBMISSIONS", conf.REWARD_POOL_ATQ_SUBMISSIONS),
    parseWei("MAX_PER_ATQ_SUBMISSION", conf.MAX_PER_ATQ_SUBMISSION)
  ),
  ...rewardKind(
    absent,
    "removed",
    parseWei("REWARD_POOL_ATQ_REMOVALS", conf.REWARD_POOL_ATQ_REMOVALS),
    parseWei("MAX_PER_ATQ_REMOVAL", conf.MAX_PER_ATQ_REMOVAL)
  ),
]
