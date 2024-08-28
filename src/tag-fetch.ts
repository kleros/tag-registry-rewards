import { Item, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"

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
        litems(where: {
          registry: "${registry}",
          metadata_: {
            key0_starts_with_nocase: "${caipAddress}",
            key0_ends_with_nocase: "${caipAddress}"
          }
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
        litems(where: {
          registryAddress: "${registry}",
          status_in: [Registered, ClearingRequested],
          latestRequestResolutionTime_gte: ${start},
  	      latestRequestResolutionTime_lt: ${end}
        }, first: 1000) {
          id
          latestRequestResolutionTime
          requests {
            requester
            requestType
            resolutionTime
          }
          metadata {
            props {
              value
            }
            key0
            key1
            key2
            key3
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
  const tags: Item[] = data.litems

  return tags
}

const parseCaip = (caip: string): { address: string; chain: number } => {
  const [, chain, address] = caip.split(":")
  return { chain: Number(chain), address }
}

const itemToTag = async (
  item: Item,
  registryType: "addressTags" | "tokens" | "domains"
): Promise<Tag> => {
  // in all 3 registries, key0 is caip address
  const { chain, address } = parseCaip(item?.metadata?.key0)
  const tag: Tag = {
    id: item.id,
    registry: registryType,
    chain,
    latestRequestResolutionTime: Number(item.latestRequestResolutionTime),
    submitter: item.requests[0].requester,
    tagAddress: address,
  }
  return tag
}

const nonTokensFromDomains = async (domainItems: Item[]): Promise<Item[]> => {
  const nonTokenDomains: Item[] = []
  for (const item of domainItems) {
    const tagMatches = await fetchTagsByAddressInRegistry(
      item?.metadata?.key0,
      "tokens",
      conf.XDAI_GTCR_SUBGRAPH_URL
    )
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
          tag.submitter !== "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6" &&
          tag.submitter !== "0xd0e76cfaa8af741f3a8b107eca76d393f734dace" &&
          tag.submitter !== "0x6f8e399b94e117d9e44311306c4c756369682720" &&
          tag.submitter !== "0xbf45d3c81f587833635b3a1907f5a26c208532e7"
      )
  )
}
