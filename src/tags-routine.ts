import { writeFileSync } from "fs"
import { fetchTags } from "./tag-fetch"
import { Period, Tag } from "./types"
import conf from "./config"
import { chainIdToRpc } from "./utils/rpcs"
import { isTaggedOnEtherscan } from "./utils/is-tagged-on-etherscan"
import { chainIdToEtherscanBasedBrowser } from "./utils/chain-id-to-etherscan-based-browser"
import { sleep } from "./transaction-sender"

const exportContractsQuery = async (tags: Tag[]): Promise<void> => {
  const contractTags: Tag[] = []
  for (const tag of tags) {
    // skip non rewarded stuff
    if (!chainIdToRpc[tag.chain]) {
      console.log("Non-rewarded tag, skipping...", tag)
      continue
    }

    const isAlreadyTagged = await isTaggedOnEtherscan(
      chainIdToEtherscanBasedBrowser[tag.chain],
      tag.tagAddress
    )

    await sleep(2)

    if (isAlreadyTagged) {
      console.log(
        "this tag is already tagged on an etherscan based browser, non-rewarded tag, skipping...",
        tag
      )
      continue
    }
    // we used to check whether if the address pointed to a contract
    // or not. but we don't need to do that, since we're already trusting the registry
    contractTags.push(tag)
  }

  // Filter by chain, turn into a set to remove dupes, parse into Dune friendly format
  const parseContractsInChain = (chain: number): string =>
    [
      ...new Set(
        contractTags
          .filter((tag) => tag.chain === chain)
          .map((tag) => tag.tagAddress)
      ),
    ].join(", ")

  const contractsTxt = `
    
    addresses_gnosis:
  
    ${parseContractsInChain(100)}

    addresses_avalanche_c

    ${parseContractsInChain(43114)}

    addresses_zksync

    ${parseContractsInChain(324)}

    addresses_fantom

    ${parseContractsInChain(250)}

    addresses_scroll

    ${parseContractsInChain(534352)}
    `
  const filename = new Date().getTime()
  writeFileSync(`./${conf.FILES_DIR}/${filename}_queries.txt`, contractsTxt)
  writeFileSync(
    `./${conf.FILES_DIR}/${filename}_tags.json`,
    JSON.stringify(contractTags)
  )

  console.log(
    "Go to https://dune.com/queries/4024703 and paste in the query parameters in",
    `${filename}_tags.txt`
  )
}

export const tagsRoutine = async (period: Period): Promise<void> => {
  console.log("Period:", period)
  const tags = await fetchTags(period)

  console.log("Tag count:")

  const countRegistry = (name: "addressTags" | "tokens" | "domains") =>
    tags
      .filter((t) => t.registry === name)
      .reduce((b, a) => {
        if (b[a.chain] === undefined) return { [a.chain]: 1, ...b }
        else return { ...b, [a.chain]: b[a.chain] + 1 }
      }, {})

  console.log("A.T.", tags.filter((t) => t.registry === "addressTags").length)
  console.log(countRegistry("addressTags"))

  console.log("Tokens", tags.filter((t) => t.registry === "tokens").length)
  console.log(countRegistry("tokens"))

  console.log("Domains", tags.filter((t) => t.registry === "domains").length)
  console.log(countRegistry("domains"))

  await exportContractsQuery(tags)
}
