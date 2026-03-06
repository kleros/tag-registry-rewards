import { fetchTags } from "./tag-fetch"
import { FilterCheckReason, FilterCheckReport, FilterCheckRow, Period, Tag } from "./types"
import { findChainConfig } from "./utils/chains"
import { isTaggedOnEtherscan } from "./utils/is-tagged-on-etherscan"
import { getAddressTagExclusionReason } from "./utils/address-tag-validation"
import { writeFilterCheckOutput } from "./utils/filter-check-output"
import { sleep } from "./transaction-sender"

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

    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg) {
      excludedRows.push(toFilterCheckRow(tag, "chain not configured for rewards"))
      continue
    }

    const isAlreadyTagged = await isTaggedOnEtherscan(
      chainCfg.explorer,
      tag.tagAddress
    )
    await sleep(2)

    if (isAlreadyTagged) {
      excludedRows.push(toFilterCheckRow(tag, "already tagged on explorer"))
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

