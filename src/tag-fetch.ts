import { Item, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"
import { sleep } from "./transaction-sender"

const fetchTagsByAddressInRegistry = async (
  caipAddress: string,
  registryType: "addressTags" | "tokens" | "domains",
  subgraphEndpoint: string
): Promise<Item[]> => {
  const registry = {
    addressTags: conf.XDAI_REGISTRY_ADDRESS_TAGS,
    tokens: conf.XDAI_REGISTRY_TOKENS,
    domains: conf.XDAI_REGISTRY_DOMAINS,
  }[registryType]
  const subgraphQuery = {
    query: `
      {
        litems:LItem(where: {
          registry_id: { _eq: "${registry}"},
            key0: {_eq: "${caipAddress}"},
        }) {
          status
          requests {
            requestType
            resolutionTime
            requester
          }
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

  const { data } = await response.json()

  const items: Item[] = data.litems

  return items
}

const fetchTagsBatchByRegistry = async (
  period: Period,
  subgraphEndpoint: string,
  registry: string
): Promise<Item[]> => {
  const [start, end] = [
    Math.floor(period.start.getTime() / 1000),
    Math.floor(period.end.getTime() / 1000),
  ]
  const subgraphQuery = {
    query: `
      {
      litems:LItem(where: {
          registryAddress: {_eq:"${registry}"},
          status: {_in: ["Registered", "ClearingRequested"]},
          latestRequestResolutionTime: {_gte: ${start}, _lt: ${end}},
        }, limit: 1000) {
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

  const { data } = await response.json()

  const tags: Item[] = data.litems

  return tags
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
  const nonTokenDomains: Item[] = []
  for (const item of domainItems) {
    const tagMatches = await fetchTagsByAddressInRegistry(
      item?.key0,
      "tokens",
      conf.XDAI_GTCR_SUBGRAPH_URL
    )
    await sleep(2)
    // check that every single one is out. this means the filter above must be length 0.
    // ow it's a token
    const includedItems = tagMatches.filter((item) =>
      ["Registered", "RemovalRequested"].includes(item.status as string)
    )
    if (includedItems.length === 0) nonTokenDomains.push(item)
  }
  return nonTokenDomains
}

export const fetchTags = async (period: Period): Promise<Tag[]> => {
  const addressTagsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_ADDRESS_TAGS
  )

  const addressTags = await Promise.all(
    addressTagsItems.map((item) => itemToTag(item, "addressTags"))
  )

  const tokensItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_TOKENS
  )
  const tokens = await Promise.all(
    tokensItems.map((item) => itemToTag(item, "tokens"))
  )

  const domainsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_DOMAINS
  )

  console.log("Filtering Tokens away from Domains for rewards")
  const nonTokenDomainsItems = await nonTokensFromDomains(domainsItems)

  const domains = await Promise.all(
    nonTokenDomainsItems.map((item) => itemToTag(item, "domains"))
  )

  return (
    addressTags
      .concat(tokens)
      .concat(domains)
      // hack to filter out auxiliary address
      .filter(
        (tag) =>
          tag !== null &&
          tag.submitter !== "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6" &&
          tag.submitter !== "0xd0e76cfaa8af741f3a8b107eca76d393f734dace" &&
          tag.submitter !== "0x6f8e399b94e117d9e44311306c4c756369682720" &&
          tag.submitter !== "0xbf45d3c81f587833635b3a1907f5a26c208532e7"
      )
  )
}
