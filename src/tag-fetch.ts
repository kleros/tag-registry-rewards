import { Item, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"

/*
 * note the two registries are considered "the same registry" in reward terms. you need to fetch from both.

 * <!> we still got the case insensitivity issue. this effectively means the only way to get "case insensitivity" is fetch
 * the entire history and filter it manually here, until The Graph finally gets case insensitive searches.
 * 
 * 1. get all tags for x address.
 * 2. get the batch from the current month.
 */

/**
 * The way to get case insensitivity is doing fulltext search.
 * But itemSearch can't filter by list, so we have to filter internally.
 * Otherwise we'd be trusting the content of items
 * Same with status (has to be Registered)
 */
const fetchTagsByAddressInRegistry = async (
  subgraphEndpoint: string,
  registry: string,
  address: string
): Promise<Item[]> => {
  const subgraphQuery = {
    query: `
      {
        itemSearch(text: "${registry} & ${address}") {
          id
          props {
            value
          }
          latestRequestResolutionTime
          registryAddress
          status
          requests {
            requester
          }
        }
      }
    `,
  }
  const response = await fetch(subgraphEndpoint, {
    method: "POST",
    body: JSON.stringify(subgraphQuery),
  })

  const { data } = (await response.json())
  const tags: Item[] = data.itemSearch
  const filteredTags = tags.filter(
    (tag) =>
      tag.registryAddress === registry.toLowerCase()
  )

  return filteredTags
}

export const fetchTagsByAddress = async (address: string): Promise<Item[]> => {
  const mainnetTagsFetch = fetchTagsByAddressInRegistry(
    conf.MAINNET_GTCR_SUBGRAPH_URL,
    conf.MAINNET_LIST_ADDRESS,
    address
  )
  const xdaiTagsFetch = fetchTagsByAddressInRegistry(
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_LIST_ADDRESS,
    address
  )

  const [mainnetTags, xdaiTags] = await Promise.all([
    mainnetTagsFetch,
    xdaiTagsFetch,
  ])

  return mainnetTags.concat(xdaiTags)
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
          status: Registered,
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
          }
        }
      }
    `,
  }
  const response = await fetch(subgraphEndpoint, {
    method: "POST",
    body: JSON.stringify(subgraphQuery),
  })

  const { data } = (await response.json())
  const tags: Item[] = data.litems

  return tags
}

const itemToTag = (item: Item): Tag => {
  // if there were multiple props with eth addresses, it should've been rejected.
  const address = item.props
    .map((prop) => prop.value)
    .find((value) => /^0x[a-fA-F0-9]{40}$/.test(value)) as string
  const tag: Tag = {
    id: item.id,
    latestRequestResolutionTime: Number(item.latestRequestResolutionTime),
    submitter: item.requests[0].requester,
    tagAddress: address,
  }
  return tag
}

const removeDupeTags = async (tags: Tag[]): Promise<Tag[]> => {
  const filteredItems: Tag[] = []
  const sameTag = (t1: Tag, t2: Tag): boolean =>
    t1.tagAddress.toLowerCase() === t2.tagAddress.toLowerCase()

  // for each tag, only add if it's the earliest instance of the address.
  for (const tag of tags) {
    const matchedItems = await fetchTagsByAddress(tag.tagAddress)
    const includedMatchedItems = matchedItems
      .filter(item => ["Registered", "ClearingRequested"].includes(item.status as string))

    const dupeTags = includedMatchedItems
      .map(item => itemToTag(item))
      .filter(matchedTag => sameTag(tag, matchedTag))

    const earliestDupes = dupeTags.sort(
      (a, b) =>
        Number(a.latestRequestResolutionTime) -
        Number(b.latestRequestResolutionTime)
    )
    // is the tag we're considering, the earliest included tag of this address?
    if (tag.id === earliestDupes[0].id) filteredItems.push(tag)
  }

  return filteredItems
}

export const fetchTagsBatch = async (period: Period): Promise<Tag[]> => {
  const mainnetTagsFetch = fetchTagsBatchByRegistry(
    period,
    conf.MAINNET_GTCR_SUBGRAPH_URL,
    conf.MAINNET_LIST_ADDRESS
  )
  const xdaiTagsFetch = fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_LIST_ADDRESS
  )

  const [mainnetTags, xdaiTags] = await Promise.all([
    mainnetTagsFetch,
    xdaiTagsFetch,
  ])
  const tags = mainnetTags.concat(xdaiTags).map((item) => itemToTag(item))
  const filteredTags = await removeDupeTags(tags)
  return filteredTags
}
