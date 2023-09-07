import { Item, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"

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
          props {
            value
          }
          latestRequestResolutionTime
          requests {
            requester
            requestType
            resolutionTime
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
  })

  const { data } = await response.json()
  const tags: Item[] = data.litems

  return tags
}

const parseCaip = (caip: string): { address: string; chain: number } => {
  const [, chain, address] = caip.split(":")
  return { chain: Number(chain), address }
}

const itemToTag = (
  item: Item,
  registryType: "addressTags" | "tokens" | "domains"
): Tag => {
  // in all 3 registries, key0 is caip address
  const { chain, address } = parseCaip(item.key0)
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

export const fetchTags = async (period: Period): Promise<Tag[]> => {
  const addressTagsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_ADDRESS_TAGS
  )

  const addressTags = addressTagsItems.map((item) =>
    itemToTag(item, "addressTags")
  )

  const tokensItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_TOKENS
  )

  const tokens = tokensItems.map((item) => itemToTag(item, "tokens"))

  const domainsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_DOMAINS
  )

  const domains = domainsItems.map((item) => itemToTag(item, "domains"))

  return addressTags.concat(tokens).concat(domains)
}
