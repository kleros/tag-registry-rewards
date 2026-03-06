import { Item, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"

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
  let offset = 0

  while (true) {
    const subgraphQuery = {
      query: `
        {
        litems:LItem(where: {
            registryAddress: {_eq:"${registry}"},
            status: {_in: ["Registered", "ClearingRequested"]},
            latestRequestResolutionTime: {_gte: ${start}, _lt: ${end}},
          }, limit: ${PAGE_SIZE}, offset: ${offset}, order_by: {id: asc}) {
            id
            latestRequestResolutionTime
            requests {
              requester
              requestType
              resolutionTime
            }
            props {
              value
            }
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

    const json = await response.json()
    const data = json.data
    if (!data) {
      console.warn("[fetchTagsBatch] Unexpected subgraph response for registry:", registry, JSON.stringify(json).slice(0, 500))
      break
    }

    const items: Item[] = data.litems || []
    allItems.push(...items)

    if (items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
    console.log(`[fetchTagsBatch] Fetched ${allItems.length} items so far for registry ${registry}, fetching more...`)
  }

  return allItems
}

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
    console.warn(`Skipping item ${item.id} – missing key0`)
    return null
  }

  // Find the LATEST registration request (most recent by resolutionTime)
  // An item can be removed and re-registered, so we reward the latest registration submitter
  const registrationRequests = item.requests
    .filter(req => req.requestType === "RegistrationRequested")
    .sort((a, b) => b.resolutionTime - a.resolutionTime)

  if (registrationRequests.length === 0) {
    console.warn(`Skipping item ${item.id} – no registration request found`)
    return null
  }

  const latestRegistrationSubmitter = registrationRequests[0].requester

  const { chain, address } = parseCaip(caip)
  return {
    id: item.id,
    registry: registryType,
    chain,
    latestRequestResolutionTime: Number(item.latestRequestResolutionTime),
    submitter: latestRegistrationSubmitter,
    tagAddress: address,
    isTokenOnAddressTags:
      registryType === "addressTags" && /\btoken\b\s*$/i.test(item?.key1 || ""),
    addressTagName:
      registryType === "addressTags" ? item?.key1?.toLowerCase() : "",
  }
}

const nonTokensFromDomains = async (domainItems: Item[]): Promise<Item[]> => {
  if (domainItems.length === 0) return []

  const caipAddresses = domainItems
    .map((item) => item?.key0)
    .filter((k): k is string => !!k)

  if (caipAddresses.length === 0) return domainItems

  // Batch query: find all items in the tokens registry matching any of these key0 values
  const allTokenItems: Item[] = []
  let offset = 0

  while (true) {
    const subgraphQuery = {
      query: `
        {
          litems:LItem(where: {
            registry_id: { _eq: "${conf.XDAI_REGISTRY_TOKENS}"},
            key0: {_in: ${JSON.stringify(caipAddresses)}},
            status: {_in: ["Registered", "ClearingRequested"]},
          }, limit: ${PAGE_SIZE}, offset: ${offset}, order_by: {id: asc}) {
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

    const json = await response.json()
    const data = json.data
    if (!data) {
      console.warn("[nonTokensFromDomains] Unexpected subgraph response:", JSON.stringify(json).slice(0, 500))
      return domainItems
    }

    const items: Item[] = data.litems || []
    allTokenItems.push(...items)

    if (items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  // Build a set of key0 values that are active tokens
  const tokenKey0Set = new Set(allTokenItems.map((item) => item.key0))

  // A domain is kept only if its key0 is NOT in the tokens registry
  return domainItems.filter((item) => !tokenKey0Set.has(item.key0))
}

export const fetchTags = async (period: Period): Promise<Tag[]> => {
  // Fetch all 3 registries in parallel
  const [addressTagsItems, tokensItems, domainsItems] = await Promise.all([
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_ADDRESS_TAGS),
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_TOKENS),
    fetchTagsBatchByRegistry(period, conf.XDAI_GTCR_SUBGRAPH_URL, conf.XDAI_REGISTRY_DOMAINS),
  ])

  console.log("Filtering Tokens away from Domains for rewards")
  const nonTokenDomainsItems = await nonTokensFromDomains(domainsItems)

  const [addressTags, tokens, domains] = await Promise.all([
    Promise.all(addressTagsItems.map((item) => itemToTag(item, "addressTags"))),
    Promise.all(tokensItems.map((item) => itemToTag(item, "tokens"))),
    Promise.all(nonTokenDomainsItems.map((item) => itemToTag(item, "domains"))),
  ])

  return addressTags
    .concat(tokens)
    .concat(domains)
    .filter((tag): tag is Tag => {
      if (!tag) return false
      return (
        tag.submitter !== "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6" &&
        tag.submitter !== "0xd0e76cfaa8af741f3a8b107eca76d393f734dace" &&
        tag.submitter !== "0x6f8e399b94e117d9e44311306c4c756369682720" &&
        tag.submitter !== "0xbf45d3c81f587833635b3a1907f5a26c208532e7"
      )
    })
}
