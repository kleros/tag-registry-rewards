import fetch from "node-fetch"
import conf from "./config"
import { AtqRow, Item, ItemRequest, Period, Removal, Tag } from "./types"
import { chainDisplayName } from "./utils/chains"
import { ExclusionList, loadExclusions } from "./utils/exclusions"
import { assertAllResolved, fillMissingKeys, isMissingRequester, UnresolvedItem } from "./utils/item-data"

const PAGE_SIZE = 1000

const registryByAddress = (): { [address: string]: Tag["registry"] } => ({
  [conf.XDAI_REGISTRY_ADDRESS_TAGS.toLowerCase()]: "addressTags",
  [conf.XDAI_REGISTRY_TOKENS.toLowerCase()]: "tokens",
  [conf.XDAI_REGISTRY_DOMAINS.toLowerCase()]: "domains",
})

// Fetch every LItem of a registry matching `where` (a Hasura condition),
// paginating through the subgraph. NOTE: never by latestRequestResolutionTime
// — it moves past the removal (e.g. a later re-registration attempt is
// rejected) and is reset to 0 by any new request, so the period must be
// checked against the *relevant request's* resolution time by each caller.
const fetchItemsWhere = async (
  registry: string,
  where: string,
  what: string
): Promise<Item[]> => {
  const allItems: Item[] = []
  // Paged by id (keyset): an item that changes while the pages are read
  // cannot shift the next page and hide an item, as an offset could.
  let afterId = ""

  for (;;) {
    const subgraphQuery = {
      query: `
        {
        litems:LItem(where: {
            registryAddress: {_eq:"${registry}"},
            ${where},
            id: {_gt: "${afterId}"},
          }, limit: ${PAGE_SIZE}, order_by: {id: asc}) {
            id
            itemID
            status
            numberOfRequests
            latestRequestResolutionTime
            latestRequestSubmissionTime
            registryAddress
            requests {
              id
              requester
              requestType
              resolutionTime
              submissionTime
            }
            data
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
    if (!response.ok) {
      throw new Error(
        `[removals-fetch] Subgraph HTTP ${response.status} for registry ${registry}`
      )
    }

    const json = await response.json()
    const data = json.data
    if (json.errors || !data) {
      // Abort instead of continuing with a partial page set: rewards are
      // pool / count, so silently missing removals would INFLATE everyone
      // else's payout and unpay the missing removers. A retry is cheap.
      throw new Error(
        `[removals-fetch] Bad subgraph response for registry ${registry}: ` +
          JSON.stringify(json).slice(0, 500)
      )
    }

    const items: Item[] = data.litems || []
    allItems.push(...items)

    if (items.length < PAGE_SIZE) break
    afterId = items[items.length - 1].id
    console.log(
      `[removals-fetch] Fetched ${allItems.length} items ${what} so far for registry ${registry}, fetching more...`
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

const fetchItemsByStatus = (registry: string, status: string): Promise<Item[]> =>
  fetchItemsWhere(registry, `status: {_eq: "${status}"}`, status)

// Every item with a removal request resolved in the period, whatever its
// status now: an item removed in the period and submitted again before the
// run is no longer Absent, and its remover would go unpaid.
const fetchItemsWithRemovalIn = (registry: string, period: Period): Promise<Item[]> => {
  const [start, end] = [Math.floor(period.start.getTime() / 1000), Math.floor(period.end.getTime() / 1000)]
  return fetchItemsWhere(
    registry,
    `requests: {requestType: {_eq: "ClearingRequested"}, resolutionTime: {_gte: ${start}, _lt: ${end}}}`,
    "with a removal resolved in the period"
  )
}

// The item's requests in the order they were made (the index ending the
// indexer's request id, "<item id>-<index>").
const inOrder = (item: Item): ItemRequest[] =>
  (item.requests || [])
    .map((request, position) => {
      const m = /-(-?\d+)$/.exec(String(request.id || "")) // "…--1": the indexer's index -1
      return { request, index: m ? Number(m[1]) : position }
    })
    .sort((a, b) => a.index - b.index)
    .map(({ request }) => request)

// The item's removal accepted in the period: a ClearingRequested resolved in
// it, after which the item left the list. That is the item's last request
// with the item Absent, or one followed by a new registration request (only
// ever made for an absent item). A removal followed by another removal
// request, or the last one of an item still registered, was rejected.
export const acceptedRemovalIn = (item: Item, period: Period): ItemRequest | null => {
  const requests = inOrder(item)
  let accepted: ItemRequest | null = null
  requests.forEach((request, i) => {
    if (request.requestType !== "ClearingRequested" || !inPeriod(Number(request.resolutionTime), period)) return
    const next = requests[i + 1]
    if (next ? next.requestType === "RegistrationRequested" : item.status === "Absent") accepted = request
  })
  return accepted
}

// The items whose request `requestOf` names no requester.
const withoutRequester = (items: Item[], requestOf: (item: Item) => ItemRequest | null, what: string): UnresolvedItem[] =>
  items
    .map((item) => ({ item, request: requestOf(item) }))
    .filter(({ request }) => !request || isMissingRequester(request.requester))
    .map(({ item, request }) => ({ id: item.id, why: `the indexer has no requester for its ${what} (${(request && request.requester) || "empty"})` }))

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

// Items whose removal (ClearingRequested) was accepted within the period.
// Rewards the remover (the requester of that removal).
export const fetchRemovals = async (period: Period, exclusions: ExclusionList = loadExclusions()): Promise<Removal[]> => {
  const registries = registryByAddress()
  const results: Removal[] = []

  for (const [address, registry] of Object.entries(registries)) {
    const items = await fetchItemsWithRemovalIn(address, period)
    console.log(
      `[removals-fetch] ${registry}: received ${items.length} items with a removal resolved in the period`
    )

    // Attributed to the period the removal itself resolved in — NOT the
    // item's latest request, which may be a later rejected re-registration.
    const removalOf = new Map<string, ItemRequest>()
    for (const item of items) {
      const removal = acceptedRemovalIn(item, period)
      if (removal) removalOf.set(item.id, removal)
    }
    const removedInPeriod = items.filter((item) => removalOf.has(item.id))

    // A removal of an item the indexer left blank is paid like any other: its
    // address comes from the item's IPFS file. Without an address it is still
    // paid (the remover earned it), deduplicated by its item id.
    const filled = await fillMissingKeys(removedInPeriod, "removals-fetch")
    for (const u of filled.unresolved) console.warn(`[removals-fetch] removal of ${u.id} paid without its address: ${u.why}`)

    // Pay only the on-chain requester of the winning ClearingRequested.
    // item.latestRequester is NOT a safe fallback: it belongs to the item's
    // latest request, which can be a later (rejected) re-registration by an
    // unrelated account. Without one (the indexer stores the zero address when
    // its read of the request failed) the run stops: nobody would be paid.
    const removalOfItem = (item: Item) => removalOf.get(item.id) || null
    const leftOut = assertAllResolved(withoutRequester(filled.items, removalOfItem, "removal"), exclusions, "removals-fetch", "removals")
    for (const item of filled.items) {
      if (leftOut.has(item.id)) continue
      const clearing = removalOf.get(item.id) as ItemRequest
      const removedAt = requestResolvedAt(item, clearing)
      const recipient = clearing.requester

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
// Registered or since challenged (ClearingRequested): a removal request
// pending at run time does not undo the registration.
export const fetchAtqRegistered = async (period: Period, exclusions: ExclusionList = loadExclusions()): Promise<AtqRow[]> => {
  const live = (await fetchItemsByStatus(conf.XDAI_REGISTRY_ATQ, "Registered")).concat(
    await fetchItemsByStatus(conf.XDAI_REGISTRY_ATQ, "ClearingRequested")
  )
  const items = live.filter((item) => {
    const registration = latestRequestOfType(item, "RegistrationRequested")
    return !!registration && inPeriod(requestResolvedAt(item, registration), period)
  })
  const rows: AtqRow[] = []
  // the keys are only the report's metadata here: an unreadable file is a warning
  const filled = await fillMissingKeys(items, "removals-fetch")
  for (const u of filled.unresolved) console.warn(`[removals-fetch] ATQ item ${u.id} listed without its metadata: ${u.why}`)
  const registrationOf = (item: Item) => latestRequestOfType(item, "RegistrationRequested")
  const leftOut = assertAllResolved(withoutRequester(filled.items, registrationOf, "registration"), exclusions, "removals-fetch", "atq")
  for (const item of filled.items) {
    if (leftOut.has(item.id)) continue
    const registration = latestRequestOfType(item, "RegistrationRequested") as ItemRequest
    rows.push({
      itemID: item.itemID ?? item.id,
      submissionTime: Number(registration.submissionTime ?? 0),
      resolutionTime: Number(registration.resolutionTime ?? 0),
      // No latestRequester fallback (it may belong to a different, later
      // request): empty requesters are dropped with a warning by the builder.
      requester: registration.requester ?? "",
      metadata: buildMetadata(item),
    })
  }
  rows.sort((a, b) => a.resolutionTime - b.resolutionTime)
  return rows
}

// ATQ removals whose ClearingRequested resolved in the period.
export const fetchAtqAbsent = async (period: Period, exclusions: ExclusionList = loadExclusions()): Promise<AtqRow[]> => {
  const removalOf = new Map<string, ItemRequest>()
  const withRemoval = await fetchItemsWithRemovalIn(conf.XDAI_REGISTRY_ATQ, period)
  for (const item of withRemoval) {
    const removal = acceptedRemovalIn(item, period)
    if (removal) removalOf.set(item.id, removal)
  }
  const items = withRemoval.filter((item) => removalOf.has(item.id))
  const rows: AtqRow[] = []
  const filled = await fillMissingKeys(items, "removals-fetch")
  for (const u of filled.unresolved) console.warn(`[removals-fetch] ATQ item ${u.id} listed without its metadata: ${u.why}`)
  const removalOfItem = (item: Item) => removalOf.get(item.id) || null
  const leftOut = assertAllResolved(withoutRequester(filled.items, removalOfItem, "removal"), exclusions, "removals-fetch", "atq")
  for (const item of filled.items) {
    if (leftOut.has(item.id)) continue
    const clearing = removalOf.get(item.id) as ItemRequest
    rows.push({
      itemID: item.itemID ?? item.id,
      submissionTime: Number(clearing.submissionTime ?? 0),
      resolutionTime: Number(clearing.resolutionTime ?? 0),
      requester: clearing.requester ?? "",
      metadata: buildMetadata(item),
    })
  }
  rows.sort((a, b) => a.resolutionTime - b.resolutionTime)
  return rows
}
