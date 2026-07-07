import { Period, RemovalsManifest } from "./types"
import {
  fetchAtqAbsent,
  fetchAtqRegistered,
  fetchRemovals,
} from "./removals-fetch"
import { buildRemovalRewards } from "./removal-reward-builder"
import { buildAtqRewards } from "./atq-reward-builder"
import { writeRemovalsOutputs } from "./utils/removals-output"

export const removalsRoutine = async (
  period: Period
): Promise<RemovalsManifest> => {
  console.log("Removals period:", period)

  const removals = await fetchRemovals(period)
  console.log("Removals found:", removals.length)

  const rewards = buildRemovalRewards(removals)
  console.log("Rewarded removals (after dedupe):", rewards.length)

  console.log("Fetching ATQ reports...")
  const [atqRegistered, atqAbsent] = await Promise.all([
    fetchAtqRegistered(period),
    fetchAtqAbsent(period),
  ])
  console.log(
    `ATQ registered: ${atqRegistered.length}, ATQ removed: ${atqAbsent.length}`
  )

  const atqRewards = buildAtqRewards(atqRegistered, atqAbsent)
  console.log("Rewarded ATQ events:", atqRewards.length)

  const runId = String(new Date().getTime())
  const manifest = await writeRemovalsOutputs(
    runId,
    period,
    rewards,
    atqRegistered,
    atqAbsent,
    atqRewards
  )

  console.log("Removals completed:", manifest)
  return manifest
}
