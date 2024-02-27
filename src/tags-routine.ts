import { writeFileSync } from "fs"
import { fetchTags } from "./tag-fetch"
import { Period, Tag } from "./types"
import conf from "./config"
import Web3 from "web3"
import { chainIdToRpc } from "./rpcs"

const isContract = async (tag: Tag): Promise<boolean> => {
  const web3 = new Web3(chainIdToRpc[tag.chain])
  const addressCode = await web3.eth.getCode(tag.tagAddress)
  if (addressCode === "0x") return false
  return true
}

const exportContractsQuery = async (tags: Tag[]): Promise<void> => {
  const contractTags: Tag[] = []
  for (const tag of tags) {
    // skip non rewarded stuff
    if (!chainIdToRpc[tag.chain]) {
      console.log("Non-rewarded tag, skipping...", tag)
      continue
    }

    console.info("Chain", tag.chain, "Checking if contract:", tag.tagAddress)
    const contractCheck = await isContract(tag)
    if (contractCheck) {
      contractTags.push(tag)
    } else {
      console.info("Tag wasn't a contract")
    }
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
    addresses_mainnet:
  
    ${parseContractsInChain(1)}
    
    addresses_gnosis:
  
    ${parseContractsInChain(100)}
  
    addresses_bnb:
  
    ${parseContractsInChain(56)}

    addresses_arbitrum

    ${parseContractsInChain(42161)}

    addresses_optimism

    ${parseContractsInChain(10)}

    addresses_avalanche_c

    ${parseContractsInChain(43114)}

    addresses_celo

    ${parseContractsInChain(42220)}

    addresses_base

    ${parseContractsInChain(8453)}

    addresses_zksync

    ${parseContractsInChain(324)}

    addresses_fantom

    ${parseContractsInChain(250)}
    `
  const filename = new Date().getTime()
  writeFileSync(`./${conf.FILES_DIR}/${filename}_queries.txt`, contractsTxt)
  writeFileSync(
    `./${conf.FILES_DIR}/${filename}_tags.json`,
    JSON.stringify(contractTags)
  )

  console.log(
    "Go to https://dune.com/queries/3454015 and paste in the query parameters in",
    `${filename}_tags.txt`
  )
}

export const tagsRoutine = async (
  period: Period
): Promise<void> => {
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
