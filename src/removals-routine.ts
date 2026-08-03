import { Period, RemovalsManifest } from "./types"
import {
  fetchAtqAbsent,
  fetchAtqRegistered,
  fetchRemovals,
} from "./removals-fetch"
import { buildRemovalRewards } from "./removal-reward-builder"
import { buildAtqRewards } from "./atq-reward-builder"
import { writeRemovalsOutputs } from "./utils/removals-output"
import {
  applyAtqExclusions,
  applyRemovalExclusions,
  ExclusionList,
  loadExclusions,
  warnUnmatchedExclusions,
} from "./utils/exclusions"

// `all` passes its shared exclusion list so hits accumulate across steps and
// the unmatched-entry check runs once for the whole run (see cli.ts).
export const removalsRoutine = async (
  period: Period,
  sharedExclusions?: ExclusionList
): Promise<RemovalsManifest> => {
  console.log("Removals period:", period)
  const exclusions = sharedExclusions ?? loadExclusions()

  // Exclusions apply BEFORE dedupe: if the kept (latest) removal of a
  // duplicated item is excluded, an earlier legitimate removal still counts.
  const removals = applyRemovalExclusions(exclusions, await fetchRemovals(period))
  console.log("Removals found:", removals.length)

  const rewards = buildRemovalRewards(removals)
  console.log("Rewarded removals (after dedupe):", rewards.length)

  console.log("Fetching ATQ reports...")
  const [atqRegisteredAll, atqAbsentAll] = await Promise.all([
    fetchAtqRegistered(period),
    fetchAtqAbsent(period),
  ])
  const atqRegistered = applyAtqExclusions(exclusions, atqRegisteredAll, "registered")
  const atqAbsent = applyAtqExclusions(exclusions, atqAbsentAll, "removed")
  console.log(
    `ATQ registered: ${atqRegistered.length}, ATQ removed: ${atqAbsent.length}`
  )

  const atqRewards = buildAtqRewards(atqRegistered, atqAbsent)
  console.log("Rewarded ATQ events:", atqRewards.length)
  if (!sharedExclusions) warnUnmatchedExclusions(exclusions, ["removals", "atq"])

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
