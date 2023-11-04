import { Item, ItemRequest, Period, Tag } from "./types"
import fetch from "node-fetch"
import conf from "./config"

const fetchTagsByAddressInRegistry = async (
  registryType: "addressTags" | "tokens" | "domains",
  address: string,
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
          key0_starts_with_nocase: "${address}",
          key0_ends_with_nocase: "${address}"
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
  })

  const { data } = await response.json()
  const items: Item[] = data.litems

  // hack for October begins...
  if (registryType !== "tokens") {
    return items
  } else {
    const subgraphQuery2 = {
      query: `
        {
          litems(where: {
            registry: "0x70533554fe5c17caf77fe530f77eab933b92af60",
            key0_starts_with_nocase: "${address}",
            key0_ends_with_nocase: "${address}"
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
    const response2 = await fetch(subgraphEndpoint, {
      method: "POST",
      body: JSON.stringify(subgraphQuery2),
    })

    const { data: data2 } = await response2.json()
    const items2: Item[] = data2.litems
    return [...items, ...items2]
  }
}

const isEdit = async (
  address: string,
  registryType: "addressTags" | "tokens" | "domains",
  editPeriod: Period
): Promise<boolean> => {
  // there should be no valid reason to edit domains.
  if (registryType === "domains") return false

  const items = await fetchTagsByAddressInRegistry(
    registryType,
    address,
    conf.XDAI_GTCR_SUBGRAPH_URL
  )
  const absentItems = items.filter((item) =>
    ["Absent", "RegistrationRequested"].includes(item.status as string)
  )

  const finishedRemovalRequests: ItemRequest[] = []
  for (const item of absentItems) {
    for (const request of item.requests) {
      if (
        request.requestType === "ClearingRequested" &&
        request.resolutionTime > 0 &&
        // filter auxiliary addresses
        request.requester !== "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6"
      ) {
        finishedRemovalRequests.push(request)
      }
    }
  }

  if (finishedRemovalRequests.length === 0) return false
  // take the latest
  const latestRequest = finishedRemovalRequests.sort(
    (a, b) => b.resolutionTime - a.resolutionTime
  )[0]
  const timestamp = latestRequest.resolutionTime
  if (
    editPeriod.start.getTime() / 1000 <= timestamp &&
    editPeriod.end.getTime() / 1000 >= timestamp
  )
    return true

  return false
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

const itemToTag = async (
  item: Item,
  registryType: "addressTags" | "tokens" | "domains",
  editPeriod: Period
): Promise<Tag> => {
  // in all 3 registries, key0 is caip address
  const { chain, address } = parseCaip(item.key0)
  const edit = await isEdit(item.key0, registryType, editPeriod)
  if (edit) console.log("got edit in registry", registryType, item.key0)
  const tag: Tag = {
    id: item.id,
    registry: registryType,
    chain,
    latestRequestResolutionTime: Number(item.latestRequestResolutionTime),
    submitter: item.requests[0].requester,
    tagAddress: address,
    edit,
  }
  return tag
}

export const fetchTags = async (
  period: Period,
  editPeriod: Period
): Promise<Tag[]> => {
  const addressTagsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_ADDRESS_TAGS
  )

  const addressTags = await Promise.all(
    addressTagsItems.map((item) => itemToTag(item, "addressTags", editPeriod))
  )

  const tokensItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_TOKENS
  )
  const tokens = await Promise.all(
    tokensItems.map((item) => itemToTag(item, "tokens", editPeriod))
  )

  // october hack, will be patched out after delivery.
  // context: a registry got submissions and was deprecated.
  const now = new Date()
  const timezone = now.getTimezoneOffset() / 60
  const start = new Date(2023, 10 - 1, 1, -timezone)
  const end = new Date(2023, 10 - 1, 9, -timezone)

  const tokensItemsOctoberHack: Item[] = await fetchTagsBatchByRegistry(
    { start: start, end: end },
    conf.XDAI_GTCR_SUBGRAPH_URL,
    "0x70533554fe5c17caf77fe530f77eab933b92af60"
  )
  const tokensHack = await Promise.all(
    tokensItemsOctoberHack.map((item) => itemToTag(item, "tokens", editPeriod))
  )
  // hacks end

  const domainsItems: Item[] = await fetchTagsBatchByRegistry(
    period,
    conf.XDAI_GTCR_SUBGRAPH_URL,
    conf.XDAI_REGISTRY_DOMAINS
  )

  const domains = await Promise.all(
    domainsItems.map((item) => itemToTag(item, "domains", editPeriod))
  )

  return (
    addressTags
      .concat(tokens)
      // hack
      .concat(tokensHack)
      .concat(domains)
      // hack to filter out auxiliary address
      .filter(
        (tag) => tag.submitter !== "0xf313d85c7fef79118fcd70498c71bf94e75fc2f6"
      )
  )
}
