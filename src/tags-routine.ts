import { ethers } from "ethers"
import { fetchTags } from "./tag-fetch"
import { ChainConfig, EnrichedTag, FetchManifest, Period, Tag } from "./types"
import { chains } from "./utils/chains"
import { enrichEvmAddressesBatch } from "./utils/evm-enrichment"
import { enrichSolanaTag } from "./utils/solana-enrichment"
import { writeFetchOutputs } from "./utils/fetch-output"
import { sleep } from "./transaction-sender"

const SOLANA_HOLDER_THRESHOLD = 5000

const isAddressTagValid = async (
  tag: Tag,
  chainCfg: ChainConfig
): Promise<boolean> => {
  if (chainCfg.namespaceId === "solana") {
    return true
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(chainCfg.rpc)
    const bytecode = await provider.getCode(tag.tagAddress)

    if (!bytecode || bytecode === "0x") {
      console.log("Not a contract, skipping...", tag)
      return false
    }

    const bytecodeNormalized = bytecode.toLowerCase().replace(/^0x/, "")
    if (bytecodeNormalized.length === 90) {
      const match = /^363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(
        bytecodeNormalized
      )
      if (match) {
        const implementation = ethers.utils.getAddress(match[1])
        const implementationCode = await provider.getCode(implementation)
        if (implementationCode && implementationCode !== "0x") {
          console.log(
            "EIP-1167 minimal proxy detected and skipped:",
            tag.tagAddress
          )
          return false
        }
      }
    }

    const contract = new ethers.Contract(
      tag.tagAddress,
      ["function supportsInterface(bytes4 interfaceID) external view returns (bool)"],
      provider
    )
    const isERC721 = await contract.supportsInterface("0x80ac58cd")
    if (isERC721) {
      console.log("ERC-721 detected and skipped:", tag.tagAddress)
      return false
    }
  } catch (err) {
    console.log(
      "Address Tags extra-check failed, keeping tag by default:",
      tag.tagAddress,
      err
    )
  }

  return true
}

const applyFetchFilters = async (tags: Tag[]): Promise<Tag[]> => {
  const filtered: Tag[] = []

  for (const tag of tags) {
    const chainCfg = chains.find(
      (c) => String(c.id).toLowerCase() === String(tag.chain).toLowerCase()
    )
    if (!chainCfg) {
      console.log("Chain not configured for rewards, skipping...", tag)
      continue
    }

    if (tag.registry === "addressTags") {
      const valid = await isAddressTagValid(tag, chainCfg)
      if (!valid) continue
    }

    filtered.push(tag)
  }

  return filtered
}

const enrichTags = async (
  tags: Tag[]
): Promise<{ enrichedTags: EnrichedTag[]; droppedBySolanaHoldersCount: number }> => {
  const evmCache: { [key: string]: { txCount: number } } = {}
  const evmBatchCacheByChain: {
    [chainId: string]: { [addressLower: string]: { txCount: number } }
  } = {}
  const solanaCache: {
    [key: string]: {
      txCount: number
      totalHolders: number | null
    }
  } = {}
  const output: EnrichedTag[] = []
  let droppedBySolanaHoldersCount = 0
  console.log(`Starting enrichment for ${tags.length} tags...`)

  const evmAddressesByChain: { [chainId: string]: string[] } = {}
  for (const tag of tags) {
    const chainCfg = chains.find(
      (c) => String(c.id).toLowerCase() === String(tag.chain).toLowerCase()
    )
    if (!chainCfg || chainCfg.namespaceId !== "eip155") continue
    if (!evmAddressesByChain[tag.chain]) {
      evmAddressesByChain[tag.chain] = []
    }
    evmAddressesByChain[tag.chain].push(tag.tagAddress)
  }

  for (const chainId of Object.keys(evmAddressesByChain)) {
    const addresses = evmAddressesByChain[chainId]
    try {
      evmBatchCacheByChain[chainId] = await enrichEvmAddressesBatch(
        chainId,
        addresses
      )
      await sleep(1)
    } catch (err) {
      console.warn(
        `[enrich] EVM batch lookup failed for chain=${chainId}, using txCount=0`,
        err
      )
      evmBatchCacheByChain[chainId] = {}
    }
  }

  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    const progress = `${index + 1}/${tags.length}`
    const chainCfg = chains.find(
      (c) => String(c.id).toLowerCase() === String(tag.chain).toLowerCase()
    )
    if (!chainCfg) continue
    if (index === 0 || (index + 1) % 10 === 0 || index === tags.length - 1) {
      console.log(
        `[enrich ${progress}] registry=${tag.registry} chain=${chainCfg.id} address=${tag.tagAddress}`
      )
    }

    const chainCaip2 = `${chainCfg.namespaceId}:${chainCfg.id}`
    const base: EnrichedTag = {
      ...tag,
      chainCaip2,
      namespaceId: chainCfg.namespaceId,
      txCount: 0,
    }

    if (chainCfg.namespaceId === "eip155") {
      const cacheKey = `${tag.chain}:${tag.tagAddress.toLowerCase()}`
      if (!evmCache[cacheKey]) {
        const addressLower = tag.tagAddress.toLowerCase()
        const chainBatch = evmBatchCacheByChain[tag.chain] || {}
        evmCache[cacheKey] = chainBatch[addressLower] || { txCount: 0 }
      }
      base.txCount = evmCache[cacheKey].txCount
    } else {
      const cacheKey = `${tag.chain}:${tag.registry}:${tag.tagAddress.toLowerCase()}`
      if (!solanaCache[cacheKey]) {
        console.log(`[enrich ${progress}] Solana lookup start`)
        solanaCache[cacheKey] = await enrichSolanaTag(tag)
        await sleep(1)
      }
      base.txCount = solanaCache[cacheKey].txCount
      const totalHolders = solanaCache[cacheKey].totalHolders
      if (
        tag.registry === "tokens" &&
        totalHolders !== null &&
        totalHolders < SOLANA_HOLDER_THRESHOLD
      ) {
        droppedBySolanaHoldersCount++
        console.log(
          `[enrich ${progress}] skipped=${base.tagAddress} reason=solana holders < ${SOLANA_HOLDER_THRESHOLD}`
        )
        continue
      }
    }
    output.push(base)
  }

  return { enrichedTags: output, droppedBySolanaHoldersCount }
}

export const tagsRoutine = async (period: Period): Promise<FetchManifest> => {
  console.log("Period:", period)
  const tags = await fetchTags(period)
  console.log("Fetched tags:", tags.length)

  const filteredTags = await applyFetchFilters(tags)
  console.log("Tags after fetch filtering:", filteredTags.length)

  const { enrichedTags, droppedBySolanaHoldersCount } = await enrichTags(filteredTags)
  const runId = String(new Date().getTime())
  const manifest = await writeFetchOutputs(
    runId,
    enrichedTags,
    droppedBySolanaHoldersCount
  )

  console.log("Fetch completed:", manifest)
  return manifest
}
