import { ethers } from "ethers"
import { fetchTags } from "./tag-fetch"
import { ChainConfig, FilterCheckReason, FilterCheckReport, FilterCheckRow, Period, Tag } from "./types"
import { chains } from "./utils/chains"
import { writeFilterCheckOutput } from "./utils/filter-check-output"

const getAddressTagExclusionReason = async (
  tag: Tag,
  chainCfg: ChainConfig
): Promise<FilterCheckReason | null> => {
  if (chainCfg.namespaceId === "solana") {
    return null
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(chainCfg.rpc)
    const bytecode = await provider.getCode(tag.tagAddress)

    if (!bytecode || bytecode === "0x") {
      return "not a contract (getCode == 0x)"
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
          return "eip-1167 minimal proxy"
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
      return "erc-721 contract"
    }
  } catch (err) {
    console.log(
      "Filter-check Address Tags validation failed, not excluding by default:",
      tag.tagAddress,
      err
    )
  }

  return null
}

const toFilterCheckRow = (tag: Tag, reason: FilterCheckReason): FilterCheckRow => ({
  id: tag.id,
  submitter: tag.submitter,
  registry: tag.registry,
  chain: tag.chain,
  tagAddress: tag.tagAddress,
  latestRequestResolutionTime: tag.latestRequestResolutionTime,
  reason,
})

export const filterCheckRoutine = async (period: Period): Promise<FilterCheckReport> => {
  console.log("Filter-check period:", period)
  const tags = await fetchTags(period)
  console.log("Filter-check fetched tags:", tags.length)

  const excludedRows: FilterCheckRow[] = []

  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    const progress = `${index + 1}/${tags.length}`

    const chainCfg = chains.find(
      (chain) => String(chain.id).toLowerCase() === String(tag.chain).toLowerCase()
    )
    if (!chainCfg) {
      excludedRows.push(toFilterCheckRow(tag, "chain not configured for rewards"))
      continue
    }

    if (tag.registry === "addressTags") {
      if (index === 0 || (index + 1) % 10 === 0 || index === tags.length - 1) {
        console.log(
          `[filter-check ${progress}] registry=${tag.registry} chain=${tag.chain} address=${tag.tagAddress}`
        )
      }
      const reason = await getAddressTagExclusionReason(tag, chainCfg)
      if (reason) {
        excludedRows.push(toFilterCheckRow(tag, reason))
      }
    }
  }

  const runId = String(new Date().getTime())
  const output = await writeFilterCheckOutput(runId, excludedRows)

  const report: FilterCheckReport = {
    runId,
    csvFile: output.csvFile,
    excludedCount: excludedRows.length,
    summaryByReason: output.summaryByReason,
  }
  console.log("Filter-check completed:", report)
  return report
}

