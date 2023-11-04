import { writeFileSync } from "fs"
import { fetchTags } from "./tag-fetch"
import { Period, Tag } from "./types"
import conf from "./config"
import Web3 from "web3"

// only used to check if something is a contract
const web3s = {
  "1": new Web3(conf.MAINNET_RPC),
  "56": new Web3(conf.BSC_RPC),
  "100": new Web3(conf.GNOSIS_RPC),
  "137": new Web3(conf.POLYGON_RPC),
}

const isContract = async (tag: Tag): Promise<boolean> => {
  const web3 = web3s[tag.chain]
  const addressCode = await web3.eth.getCode(tag.tagAddress)
  if (addressCode === "0x") return false
  return true
}

const exportContractsQuery = async (tags: Tag[]): Promise<void> => {
  const contractTags: Tag[] = []
  for (const tag of tags) {
    // skip non rewarded stuff
    if (![1, 56, 100, 137].includes(tag.chain)) {
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
  
    addresses_polygon:
  
    ${parseContractsInChain(137)}
  
    addresses_bnb:
  
    ${parseContractsInChain(56)}
    `
  const filename = new Date().getTime()
  writeFileSync(`./${conf.FILES_DIR}/${filename}_queries.txt`, contractsTxt)
  writeFileSync(
    `./${conf.FILES_DIR}/${filename}_tags.json`,
    JSON.stringify(tags)
  )

  console.log(
    "Go to https://dune.com/queries/3078126 and paste in the query parameters in",
    `${filename}_tags.txt`
  )
}

export const tagsRoutine = async (
  period: Period,
  editPeriod: Period
): Promise<void> => {
  console.log("Period:", period)
  console.log("Edit period:", editPeriod)
  const tags = await fetchTags(period, editPeriod)

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
