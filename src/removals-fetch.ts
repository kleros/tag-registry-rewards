import fetch from "node-fetch"
import conf from "./config"
import { AtqRow, Item, ItemRequest, Period, Removal, Tag } from "./types"
import { chainDisplayName } from "./utils/chains"

const PAGE_SIZE = 1000

const registryByAddress = (): { [address: string]: Tag["registry"] } => ({
  [conf.XDAI_REGISTRY_ADDRESS_TAGS.toLowerCase()]: "addressTags",
  [conf.XDAI_REGISTRY_TOKENS.toLowerCase()]: "tokens",
  [conf.XDAI_REGISTRY_DOMAINS.toLowerCase()]: "domains",
})

// Fetch every LItem for a registry in the given status, paginating through the
// subgraph. NOTE: no time filter here on purpose — an item's
// latestRequestResolutionTime can move past the removal (e.g. a later
// re-registration attempt is rejected), so the period must be checked against
// the *relevant request's* resolution time client-side by each caller.
const fetchItemsByStatus = async (
  registry: string,
  status: string
): Promise<Item[]> => {
  const allItems: Item[] = []
  let offset = 0

  while (true) {
    const subgraphQuery = {
      query: `
        {
        litems:LItem(where: {
            registryAddress: {_eq:"${registry}"},
            status: {_eq: "${status}"},
          }, limit: ${PAGE_SIZE}, offset: ${offset}, order_by: {id: asc}) {
            id
            itemID
            status
            numberOfRequests
            latestRequestResolutionTime
            latestRequestSubmissionTime
            latestRequester
            registryAddress
            requests {
              requester
              requestType
              resolutionTime
              submissionTime
            }
            key0
            key1
            key2
            key3
          }
        }
      `,
    }
    const response = await fetch(conf.XDAI_GTCR_SUBGRAPH_URL, {
      method: "POST",
      body: JSON.stringify(subgraphQuery),
      headers: { "Content-Type": "application/json" },
    })

    const json = await response.json()
    const data = json.data
    if (!data) {
      console.warn(
        "[removals-fetch] Unexpected subgraph response for registry:",
        registry,
        JSON.stringify(json).slice(0, 500)
      )
      break
    }

    const items: Item[] = data.litems || []
    allItems.push(...items)

    if (items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
    console.log(
      `[removals-fetch] Fetched ${allItems.length} ${status} items so far for registry ${registry}, fetching more...`
    )
  }

  return allItems
}

const parseCaip = (caip?: string): { chain: string; address: string } | null => {
  if (!caip || !caip.includes(":")) return null
  const [, chain, address] = caip.split(":")
  if (!chain || !address) return null
  return { chain, address }
}

const latestRequestOfType = (
  item: Item,
  type: "ClearingRequested" | "RegistrationRequested"
): ItemRequest | null => {
  const matches = (item.requests || []).filter(
    (req) => req.requestType === type
  )
  if (matches.length === 0) return null
  return matches
    .slice()
    .sort((a, b) => Number(b.resolutionTime) - Number(a.resolutionTime))[0]
}

// The moment a request became final, used both for period filtering and display.
const requestResolvedAt = (item: Item, request: ItemRequest): number =>
  Number(request.resolutionTime) ||
  Number(request.submissionTime) ||
  Number(item.latestRequestResolutionTime) ||
  Number(item.latestRequestSubmissionTime) ||
  0

const inPeriod = (unixSeconds: number, period: Period): boolean => {
  const start = Math.floor(period.start.getTime() / 1000)
  const end = Math.floor(period.end.getTime() / 1000)
  return unixSeconds >= start && unixSeconds < end
}

// Absent items whose removal (ClearingRequested) resolved within the period.
// Rewards the remover (requester of the latest ClearingRequested).
export const fetchRemovals = async (period: Period): Promise<Removal[]> => {
  const registries = registryByAddress()
  const results: Removal[] = []

  for (const [address, registry] of Object.entries(registries)) {
    const items = await fetchItemsByStatus(address, "Absent")
    console.log(
      `[removals-fetch] ${registry}: received ${items.length} Absent items`
    )

    for (const item of items) {
      // A genuine removal (registered, then cleared) has more than one request.
      // Registrations that were simply rejected have exactly one.
      if (Number(item.numberOfRequests ?? 0) <= 1) continue

      const clearing = latestRequestOfType(item, "ClearingRequested")
      if (!clearing) continue

      // Attribute to the period the removal itself resolved in — NOT the item's
      // latest request, which may be a later rejected re-registration.
      const removedAt = requestResolvedAt(item, clearing)
      if (!inPeriod(removedAt, period)) continue

      const recipient = clearing.requester || item.latestRequester || ""
      if (!recipient) continue // cannot pay an unknown remover

      const parsed = parseCaip(item.key0)

      results.push({
        id: item.id,
        itemID: item.itemID ?? item.id,
        registry,
        chain: parsed?.chain ?? "",
        chainName: parsed ? chainDisplayName(parsed.chain) : "",
        submitter: recipient,
        tagAddress: parsed?.address ?? "",
        removedAt,
      })
    }
  }

  return results
}

const buildMetadata = (item: Item): string =>
  [item.key0, item.key1, item.key2, item.key3]
    .filter((k) => k && k.length > 0)
    .join(" | ")

// ATQ registered submissions whose latest registration resolved in the period.
export const fetchAtqRegistered = async (period: Period): Promise<AtqRow[]> => {
  const items = await fetchItemsByStatus(conf.XDAI_REGISTRY_ATQ, "Registered")
  const rows: AtqRow[] = []
  for (const item of items) {
    const registration = latestRequestOfType(item, "RegistrationRequested")
    if (!registration) continue
    const resolvedAt = requestResolvedAt(item, registration)
    if (!inPeriod(resolvedAt, period)) continue
    rows.push({
      itemID: item.itemID ?? item.id,
      submissionTime: Number(registration.submissionTime ?? 0),
      resolutionTime: Number(registration.resolutionTime ?? 0),
      requester: registration.requester ?? item.latestRequester ?? "",
      metadata: buildMetadata(item),
    })
  }
  rows.sort((a, b) => a.resolutionTime - b.resolutionTime)
  return rows
}

// ATQ removals whose ClearingRequested resolved in the period.
export const fetchAtqAbsent = async (period: Period): Promise<AtqRow[]> => {
  const items = await fetchItemsByStatus(conf.XDAI_REGISTRY_ATQ, "Absent")
  const rows: AtqRow[] = []
  for (const item of items) {
    if (Number(item.numberOfRequests ?? 0) <= 1) continue
    const clearing = latestRequestOfType(item, "ClearingRequested")
    if (!clearing) continue
    const resolvedAt = requestResolvedAt(item, clearing)
    if (!inPeriod(resolvedAt, period)) continue
    rows.push({
      itemID: item.itemID ?? item.id,
      submissionTime: Number(clearing.submissionTime ?? 0),
      resolutionTime: Number(clearing.resolutionTime ?? 0),
      requester: clearing.requester ?? item.latestRequester ?? "",
      metadata: buildMetadata(item),
    })
  }
  rows.sort((a, b) => a.resolutionTime - b.resolutionTime)
  return rows
}
