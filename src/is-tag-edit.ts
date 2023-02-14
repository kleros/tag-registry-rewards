import { fetchTagsByAddress } from "./tag-fetch"
import { ItemRequest, Period } from "./types"

/*
1. get all items related to an address, filter by removed items.
2. get removal requests associated with those items.
3. [] => not edit. ![] => sort by time of resolution, and take the most recent.
4. check if the timestamp is within the period, or the previous period.
*/

export const isEdit = async (address: string, editPeriod: Period): Promise<boolean> => {
  const items = await fetchTagsByAddress(address)
  const absentItems = items
    .filter(item => ["Absent", "RegistrationRequested"].includes(item.status as string))

  const finishedRemovalRequests: ItemRequest[] = []

  for (const item of absentItems) {
    for (const request of item.requests) {
      if (request.requestType === "ClearingRequested" && request.resolutionTime > 0) {
        finishedRemovalRequests.push(request)
      }
    }
  }

  if (finishedRemovalRequests.length === 0) return true
  // take the latest
  const latestRequest = finishedRemovalRequests.sort((a, b) => b.resolutionTime - a.resolutionTime)[0]
  const timestamp = latestRequest.resolutionTime
  if (
    editPeriod.start.getTime() / 1000 <= timestamp
    && editPeriod.end.getTime() / 1000 >= timestamp
  ) return true

  return false
}
