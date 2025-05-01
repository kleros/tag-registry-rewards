import { writeFileSync } from "fs"
import { fetchTags } from "./tag-fetch"
import { Period, Tag } from "./types"
import conf from "./config"
import { isTaggedOnEtherscan } from "./utils/is-tagged-on-etherscan"
import { sleep } from "./transaction-sender"
import { chains } from "./utils/chains"
import { getSolanaTokenHolderCount } from './utils/fetch-solana-token-holder-count'
import { ethers } from "ethers";

const exportContractsQuery = async (tags: Tag[]): Promise<void> => {
  const contractTags: Tag[] = []
  const solanaChain = chains.find(c => c.namespaceId === 'solana')
  const solanaTokenHolderThreshold = 5000

  for (const tag of tags) {
    // skip non rewarded stuff
    const rewardedChain = chains.find(c => c.id === String(tag.chain))

    if (!rewardedChain) {
      console.log("Non-rewarded tag, skipping...", tag)
      continue
    }

    const isAlreadyTagged = await isTaggedOnEtherscan(
      rewardedChain.explorer,
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
  
    if (tag.registry === 'tokens' && String(tag.chain).toLowerCase() === String(solanaChain!.id).toLowerCase()) {
      const holderCount = await getSolanaTokenHolderCount(tag.tagAddress.toLowerCase(), conf.HELIUS_SOLANA_API_KEY)
  
      if (holderCount < solanaTokenHolderThreshold) {
        console.log(`Token holder count below threshold (${solanaTokenHolderThreshold}), skipping...`, tag)
        continue
      }
    }

    if (tag.isTokenOnAddressTags) {
      console.log("Token submitted inside Address Tag Registry, Non-rewarded tag, skipping...", tag)
      continue
    }

    // checks if an NFT was submitted on the Address Tag registry, and excludes it from rewards.
    if (tag.registry === "addressTags") {
      const chainCfg = chains.find(c => String(c.id).toLowerCase() === String(tag.chain).toLowerCase() && c.namespaceId === 'eip155')
      if (!chainCfg) {
        console.log("No RPC found for chain, skipping...", tag)
        continue
      }
    
      try {
        const provider = new ethers.providers.JsonRpcProvider(chainCfg.rpc)
        const bytecode = await provider.getCode(tag.tagAddress)
    
        if (!bytecode || bytecode === "0x") {
          console.log("Not a contract, skipping...", tag)
          continue
        }
    
        const contract = new ethers.Contract(
          tag.tagAddress,
          ["function supportsInterface(bytes4 interfaceID) external view returns (bool)"],
          provider
        )
    
        const isERC721 = await contract.supportsInterface("0x80ac58cd")
        if (isERC721) {
          console.log("ERC721 (NFT) detected via supportsInterface, skipping...", tag)
          continue
        }
      } catch (e) {
        console.log("Not an NFT, tag is valid, proceeding with tag:", tag)
      }
    }
    // we used to check whether if the address pointed to a contract
    // or not. but we don't need to do that, since we're already trusting the registry
    contractTags.push(tag)
  }

  // Filter by chain, turn into a set to remove dupes, parse into Dune friendly format
  const parseContractsInChain = (chain) =>
    [
      ...new Set(
        contractTags
          .filter((tag) => tag.chain.toLowerCase() === chain.toLowerCase())
          .map((tag) => tag.tagAddress)
      )
    ].map((addr) =>
      chain === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ? `'${addr}'` : addr
    ).join(", ");

  const contractsTxt = `
    
    addresses_gnosis:
  
    ${parseContractsInChain("100")}

    addresses_avalanche_c

    ${parseContractsInChain("43114")}

    addresses_zksync

    ${parseContractsInChain("324")}

    addresses_fantom

    ${parseContractsInChain("250")}

    addresses_scroll

    ${parseContractsInChain("534352")}

    addresses_celo

    ${parseContractsInChain("42220")}

    addresses_base

    ${parseContractsInChain("8453")}

    addresses_solana

    ${parseContractsInChain("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")}
    `

  const filename = new Date().getTime()
  writeFileSync(`./${conf.FILES_DIR}/${filename}_queries.txt`, contractsTxt)
  writeFileSync(
    `./${conf.FILES_DIR}/${filename}_tags.json`,
    JSON.stringify(contractTags)
  )

  console.log(
    "Go to https://dune.com/queries/5068623 and paste in the query parameters in",
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
