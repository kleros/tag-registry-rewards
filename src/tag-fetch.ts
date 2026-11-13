import { Item, ItemRequest, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"
import { assertAllResolved, fillMissingKeys, isMissingRequester, keysFromItemFile, UnresolvedItem } from "./utils/item-data"
import { ExclusionList, loadExclusions } from "./utils/exclusions"
import { httpFetch } from "./utils/http"

const PAGE_SIZE = 1000

const fetchTagsBatchByRegistry = async (
  period: Period,
  subgraphEndpoint: string,
  registry: string
): Promise<Item[]> => {
  const [start, end] = [
    Math.floor(period.start.getTime() / 1000),
    Math.floor(period.end.getTime() / 1000),
  ]

  const allItems: Item[] = []
  // Paged by id (keyset): an item that changes while the pages are read
  // cannot shift the next page and hide an item, as an offset could.
  let afterId = ""

  // Selected by the registration request resolved in the period, and by the
  // item's latestRequestResolutionTime, which alone would not do: the indexer
  // resets it to 0 when a removal request is submitted (an item registered in
  // the period and challenged since would never match) and moves it to a
  // rejected removal's resolution (fetchTags drops those: registered before).
  // An item whose registration request the indexer lost still matches by it.
  for (;;) {
    const subgraphQuery = {
      query: `
        {
        litems:LItem(where: {
            registryAddress: {_eq:"${registry}"},
            status: {_in: ["Registered", "ClearingRequested"]},
            _or: [
              {latestRequestResolutionTime: {_gte: ${start}, _lt: ${end}}},
              {requests: {requestType: {_eq: "RegistrationRequested"}, resolutionTime: {_gte: ${start}, _lt: ${end}}}},
            ],
            id: {_gt: "${afterId}"},
          }, limit: ${PAGE_SIZE}, order_by: {id: asc}) {
            id
            latestRequestResolutionTime
            requests {
              requester
              requestType
              resolutionTime
              submissionTime
            }
            props {
              value
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
    const response = await fetch(subgraphEndpoint, {
      method: "POST",
      body: JSON.stringify(subgraphQuery),
      headers: {
        "Content-Type": "application/json",
      },
    })
    if (!response.ok) {
      throw new Error(`[fetchTagsBatch] Subgraph HTTP ${response.status} for registry ${registry}`)
    }

    const json = await response.json()
    const data = json.data
    if (json.errors || !data) {
      // Abort instead of continuing with a partial page set: rewards are
      // pool-based, so silently missing tags would inflate everyone else's
      // payout and unpay the missing submitters. A retry is cheap.
      throw new Error(`[fetchTagsBatch] Bad subgraph response for registry ${registry}: ${JSON.stringify(json).slice(0, 500)}`)
    }

    const items: Item[] = data.litems || []
    allItems.push(...items)

    if (items.length < PAGE_SIZE) break
    afterId = items[items.length - 1].id
    console.log(`[fetchTagsBatch] Fetched ${allItems.length} items so far for registry ${registry}, fetching more...`)
  }

  return allItems
}

// The item's latest resolved registration request (an item can be removed and
// registered again), or undefined.
export const latestRegistration = (item: Item): ItemRequest | undefined =>
  (item.requests || [])
    .filter((req) => req.requestType === "RegistrationRequested" && Number(req.resolutionTime) > 0)
    .sort((a, b) => Number(b.resolutionTime) - Number(a.resolutionTime))[0]

const parseCaip = (caip?: string): { address: string; chain: string } => {
  if (!caip || !caip.includes(":"))
    throw new Error(`Invalid CAIP string received: "${caip}"`)
  const [, chain, address] = caip.split(":")
  return { chain, address }
}

const itemToTag = async (
  item: Item,
  registryType: "addressTags" | "tokens" | "domains"
): Promise<Tag | null> => {
  const caip = item?.key0
  if (!caip) {
    // unreachable: fetchTags stops on, or leaves out, an item without key0
    console.warn(`Skipping item ${item.id} – missing key0`)
    return null
  }

  // An item can be removed and re-registered: the latest registration's
  // submitter is rewarded (fetchTags checked it resolved in the period).
  const registration = latestRegistration(item)
  if (!registration) {
    console.warn(`Skipping item ${item.id} – no registration request found`)
    return null
  }

  const { chain, address } = parseCaip(caip)
  // when the registration was requested: what the explorer rule dates a tag against
  const submissionTime = Number(registration.submissionTime)
  return {
    id: item.id,
    registry: registryType,
    chain,
    latestRequestResolutionTime: Number(registration.resolutionTime),
    ...(submissionTime > 0 ? { submissionTime } : {}),
    submitter: registration.requester,
    tagAddress: address,
    isTokenOnAddressTags:
      registryType === "addressTags" && /\btoken\b\s*$/i.test(item?.key1 || ""),
    addressTagName:
      registryType === "addressTags" ? item?.key1?.toLowerCase() : "",
  }
}

// A CAIP-10 key0 as the address it names: an EVM address (eip155) is the same
// in any letter case (0xAbC… and 0xabc…), a Solana one is not (base58).
export const caipAddressKey = (key0: string): string => {
  const key = key0.trim()
  return /^eip155:/i.test(key) ? key.toLowerCase() : key
}

// CDN entries whose contract is live in the Tokens registry are not rewarded
// (the Contract Domain Name rules). Compared by address, so a token registered
// as 0xabc… also excludes the CDN entry written 0xAbC…: every live Tokens
// entry is read (key0 only), since the indexer matches key0 letter for letter.
const nonTokensFromDomains = async (domainItems: Item[], exclusions: ExclusionList): Promise<Item[]> => {
  if (domainItems.length === 0) return []

  const allTokenItems: Item[] = []
  // Paged by id (keyset): an item that changes while the pages are read
  // cannot shift the next page and hide an item, as an offset could.
  let afterId = ""

  for (;;) {
    const subgraphQuery = {
      query: `
        {
          litems:LItem(where: {
            registry_id: { _eq: "${conf.XDAI_REGISTRY_TOKENS}"},
            status: {_in: ["Registered", "ClearingRequested"]},
            id: {_gt: "${afterId}"},
          }, limit: ${PAGE_SIZE}, order_by: {id: asc}) {
            id
            data
            key0
            status
          }
        }
      `,
    }

    const response = await fetch(conf.XDAI_GTCR_SUBGRAPH_URL, {
      method: "POST",
      body: JSON.stringify(subgraphQuery),
      headers: {
        "Content-Type": "application/json",
      },
    })
    if (!response.ok) {
      throw new Error(`[nonTokensFromDomains] Subgraph HTTP ${response.status}`)
    }

    const json = await response.json()
    const data = json.data
    if (json.errors || !data) {
      // Returning the unfiltered list here would keep token-domains in the
      // domains pool and reward them twice — abort and retry instead.
      throw new Error(`[nonTokensFromDomains] Bad subgraph response: ${JSON.stringify(json).slice(0, 500)}`)
    }

    const items: Item[] = data.litems || []
    allTokenItems.push(...items)

    if (items.length < PAGE_SIZE) break
    afterId = items[items.length - 1].id
  }

  // A live token the indexer left blank still excludes its CDN entries. One
  // whose file cannot be read, or whose data names no file, might be any
  // address: the run stops (unless exclusions.json names it). One whose item
  // file names no address matches none.
  const { items: tokenItems, unresolved } = await fillMissingKeys(allTokenItems, "fetch")
  const unreadable = unresolved.filter((u) => !/names no address/.test(u.why))
  assertAllResolved(unreadable, exclusions, "fetch")
  for (const u of unresolved) if (!unreadable.includes(u)) console.warn(`[fetch] live token ${u.id}: ${u.why}`)
  const tokenAddresses = new Set(tokenItems.filter((item) => !!item.key0).map((item) => caipAddressKey(item.key0)))

  // A domain is kept only if its address is NOT a live token (one still
  // without key0 is one exclusions.json names, skipped when read)
  const kept = domainItems.filter((item) => !item.key0 || !tokenAddresses.has(caipAddressKey(item.key0)))
  const exact = new Set(tokenItems.map((item) => item.key0))
  const caseOnly = domainItems.filter(
    (item) => !!item.key0 && !exact.has(item.key0) && tokenAddresses.has(caipAddressKey(item.key0))
  ).length
  console.log(
    `[fetch] ${domainItems.length - kept.length} of ${domainItems.length} Domains entries are live in the Tokens registry: ` +
      `not rewarded${caseOnly > 0 ? ` (${caseOnly} of them written there in another letter case)` : ""}`
  )
  return kept
}

// The address an item's values name, written as CAIP-10 (eip155:<chain>:0x…):
// the "Contract Address" or "Address" field, else the only value written so.
// null when there is none, or more than one with no such field to choose.
const CAIP_EVM = /^eip155:\d+:0x[0-9a-fA-F]{40}$/
const addressInValues = (values: { [label: string]: unknown }): string | null => {
  for (const label of ["Contract Address", "Address"]) {
    const value = typeof values[label] === "string" ? (values[label] as string).trim() : ""
    if (CAIP_EVM.test(value)) return value
  }
  const found = Object.values(values)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => CAIP_EVM.test(value))
  return found.length === 1 ? found[0] : null
}

const REGISTRATION_LOOKUP_TIMEOUT_MS = 120000 // per page of the indexer
// What a network error was (ECONNREFUSED, request-timeout…), without its
// message: node-fetch's names the URL.
const networkErrorCode = (err: unknown): string => {
  const { code, type } = (err || {}) as { code?: unknown; type?: unknown }
  return String(code || type || "no answer")
}

// Every registration the Address Tags and Tokens registries ever resolved for
// an address (whatever became of the entry since), the earliest first: the
// explorer check asks it before holding a tag against an entry, since a tag an
// explorer took from an earlier Kleros entry never counts. Both registries are
// read once, on the first question (the indexer matches key0 letter for
// letter, so addresses are compared here as caipAddressKey writes them,
// whatever their spelling); an item the indexer left blank is read from its
// data (inline JSON) or its IPFS file. One whose IPFS file cannot be read now
// might be any address: the lookup then fails, which keeps every entry from
// being excluded in the run (a later run may read it). One whose data is
// malformed for good is named in a warning and left out: failing on it would
// keep every entry of every run from being excluded, for a one-in-thousands
// chance that it was the entry's address. A resolved request that was
// rejected counts too: that also only ever keeps an entry.
export const registrationLookup = (): ((chainId: string, address: string) => Promise<{ id: string; resolvedAt: number }[]>) => {
  let loaded: Promise<Map<string, { id: string; resolvedAt: number }[]>> | undefined
  const load = async (): Promise<Map<string, { id: string; resolvedAt: number }[]>> => {
    const byAddress = new Map<string, { id: string; resolvedAt: number }[]>()
    for (const registry of [conf.XDAI_REGISTRY_ADDRESS_TAGS, conf.XDAI_REGISTRY_TOKENS]) {
      const items: Item[] = []
      let afterId = ""
      for (;;) {
        // A stalled indexer must not hold the run. The network's errors name
        // its URL, key and all, and these reach the verdicts and their file:
        // only their code is kept.
        const response = await httpFetch(conf.XDAI_GTCR_SUBGRAPH_URL, {
          method: "POST",
          body: JSON.stringify({
            query: `
              {
                litems:LItem(where: {
                  registryAddress: {_eq:"${registry}"},
                  id: {_gt: "${afterId}"},
                }, limit: ${PAGE_SIZE}, order_by: {id: asc}) {
                  id
                  data
                  key0
                  requests {
                    requestType
                    resolutionTime
                  }
                }
              }
            `,
          }),
          headers: { "Content-Type": "application/json" },
          timeout: REGISTRATION_LOOKUP_TIMEOUT_MS,
        }).catch((err: unknown) => {
          throw new Error(`the indexer could not be reached (${networkErrorCode(err)})`)
        })
        if (!response.ok) throw new Error(`the indexer answered HTTP ${response.status}`)
        const json = await response.json().catch((err: unknown) => {
          throw new Error(`the indexer's answer could not be read (${networkErrorCode(err)})`)
        })
        if (json.errors || !json.data) throw new Error(`the indexer answered ${JSON.stringify(json).slice(0, 200)}`)
        const page: Item[] = json.data.litems || []
        items.push(...page)
        if (page.length < PAGE_SIZE) break
        afterId = page[page.length - 1].id
      }
      // A blank item whose data is the item itself (inline JSON, early
      // Address Tags forms) holds its keys there: an item file ({ columns,
      // values }), or its values alone ({"Contract Address": "eip155:10:0x…",
      // "Public Name Tag": …}, a registered Beethoven X entry of 2025). One
      // whose file names no address cannot be any address's tag.
      const noAddress = new Set<string>()
      const inline = items.map((item) => {
        if (item.key0 || !item.data) return item
        let file: { columns?: unknown; values?: unknown } | null
        try {
          file = JSON.parse(item.data)
        } catch {
          return item
        }
        if (!file || typeof file !== "object" || Array.isArray(file)) return item
        if (!Array.isArray(file.columns) || !file.values) {
          const address = addressInValues(file as { [label: string]: unknown })
          return address ? { ...item, key0: address } : item
        }
        const keys = keysFromItemFile(file)
        if (keys && keys.key0 && keys.key0 !== "-") return { ...item, ...keys }
        noAddress.add(item.id)
        return item
      })
      const { items: filled, unresolved } = await fillMissingKeys(
        inline.filter((item) => !noAddress.has(item.id)),
        "explorer-dating"
      )
      const unknown = unresolved.filter((u) => /could not be read/.test(u.why))
      for (const u of unresolved.filter((u) => /names no IPFS file/.test(u.why))) {
        console.warn(`[explorer-dating] an earlier entry's data is malformed, its address unknown (left out): ${u.id}: ${u.why}`)
      }
      if (unknown.length > 0) {
        throw new Error(
          `the address of ${unknown.length} earlier entr${unknown.length === 1 ? "y" : "ies"} could not be read (` +
            unknown.map((u) => `${u.id}: ${u.why}`).join("; ").slice(0, 300) +
            ")"
        )
      }
      for (const item of filled) {
        if (!item.key0) continue
        const key = caipAddressKey(item.key0)
        for (const request of item.requests || []) {
          const resolvedAt = Number(request.resolutionTime)
          if (request.requestType !== "RegistrationRequested" || !(resolvedAt > 0)) continue
          byAddress.set(key, (byAddress.get(key) || []).concat({ id: item.id, resolvedAt }))
        }
      }
    }
    for (const list of byAddress.values()) list.sort((a, b) => a.resolvedAt - b.resolvedAt)
    return byAddress
  }
  return async (chainId, address) => {
    if (!loaded) loaded = load()
    return (await loaded).get(caipAddressKey(`eip155:${chainId}:${address}`)) || []
  }
}

// Submitters never rewarded, compared case-insensitively (the indexer returns
// lowercase addresses today, a checksummed one must not slip through).
const EXCLUDED_SUBMITTERS = new Set([
  "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6",
  "0xd0e76cfaa8af741f3a8b107eca76d393f734dace",
  "0x6f8e399b94e117d9e44311306c4c756369682720",
  "0xbf45d3c81f587833635b3a1907f5a26c208532e7",
])

// Every registered item of the period becomes a tag, or the run stops: one
// the indexer left blank is read from its IPFS file, and one that cannot be
// read at all, or has no registration request, is left out only when
// exclusions.json names it. Nothing registered is dropped silently.
// `exclusions`: the run's shared list, so that entries used here count as matched.
export const fetchTags = async (period: Period, exclusions: ExclusionList = loadExclusions()): Promise<Tag[]> => {
  // Fetch all 3 registries in parallel
  const raw = await Promise.all([
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_ADDRESS_TAGS),
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_TOKENS),
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_DOMAINS),
  ])
  // An item is this period's when its latest registration resolved in it: a
  // later one (removed and registered again after the period) makes it the
  // next period's, an earlier one means the request resolved in the period
  // came after it (a rejected removal), already paid when it was registered.
  const [start, end] = [Math.floor(period.start.getTime() / 1000), Math.floor(period.end.getTime() / 1000)]
  const current = raw.map((items) =>
    items.filter((item) => {
      const registration = latestRegistration(item)
      if (!registration) return true // stops below
      const time = Number(registration.resolutionTime)
      const at = new Date(time * 1000).toISOString()
      if (time >= end) console.log(`[fetch] ${item.id}: registered again after the period (${at}), rewarded then`)
      else if (time < start) console.log(`[fetch] ${item.id}: registered before the period (${at}); a later request resolved in it`)
      return time >= start && time < end
    })
  )
  const unresolved: UnresolvedItem[] = []
  const filled: Item[][] = []
  for (const items of current) {
    const result = await fillMissingKeys(items, "fetch")
    unresolved.push(...result.unresolved)
    filled.push(result.items)
  }
  for (const item of filled.flat()) {
    if (!item.key0) continue
    const registration = latestRegistration(item)
    if (!/^[^:\s]+:[^:\s]+:\S+$/.test(item.key0.trim())) {
      unresolved.push({ id: item.id, why: `its key0 is not a CAIP-10 address (${JSON.stringify(item.key0).slice(0, 80)})` })
    } else if (!registration) {
      unresolved.push({ id: item.id, why: "the indexer has no registration request for it" })
    } else if (isMissingRequester(registration.requester)) {
      unresolved.push({ id: item.id, why: `the indexer has no requester for its registration (${registration.requester || "empty"})` })
    }
  }
  const leftOut = assertAllResolved(unresolved, exclusions, "fetch")
  const [addressTagsItems, tokensItems, domainsItems] = filled.map((items) => items.filter((item) => !leftOut.has(item.id)))

  console.log("Filtering Tokens away from Domains for rewards")
  const nonTokenDomainsItems = await nonTokensFromDomains(domainsItems, exclusions)

  const [addressTags, tokens, domains] = await Promise.all([
    Promise.all(addressTagsItems.map((item) => itemToTag(item, "addressTags"))),
    Promise.all(tokensItems.map((item) => itemToTag(item, "tokens"))),
    Promise.all(nonTokenDomainsItems.map((item) => itemToTag(item, "domains"))),
  ])

  return addressTags
    .concat(tokens)
    .concat(domains)
    .filter((tag): tag is Tag => !!tag && !EXCLUDED_SUBMITTERS.has(String(tag.submitter || "").toLowerCase()))
}
