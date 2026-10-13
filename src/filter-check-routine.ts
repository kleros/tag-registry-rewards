import { fetchTags } from "./tag-fetch"
import { FilterCheckReport, FilterCheckRow, Period } from "./types"
import { writeExplorerCheck, writeFilterCheckOutput } from "./utils/filter-check-output"
import { applyTagFilters } from "./utils/tag-filters"

export const filterCheckRoutine = async (period: Period): Promise<FilterCheckReport> => {
  console.log("Filter-check period:", period)
  const tags = await fetchTags(period)
  console.log("Filter-check fetched tags:", tags.length)

  const { excluded, explorerReview } = await applyTagFilters(tags, { period })

  const excludedRows: FilterCheckRow[] = excluded.map(({ tag, reason, detail }) => ({
    id: tag.id,
    submitter: tag.submitter,
    registry: tag.registry,
    chain: tag.chain,
    tagAddress: tag.tagAddress,
    latestRequestResolutionTime: tag.latestRequestResolutionTime,
    reason,
    ...(detail ? { detail } : {}),
  }))

  const runId = String(new Date().getTime())
  const output = await writeFilterCheckOutput(runId, excludedRows)
  const explorerFile = await writeExplorerCheck(runId, explorerReview)
  const tagged = explorerReview.filter((r) => r.status === "tagged").length

  const report: FilterCheckReport = {
    runId,
    csvFile: output.csvFile,
    excludedCount: excludedRows.length,
    ...(explorerFile
      ? { explorerTaggedCount: tagged, explorerNotReadCount: explorerReview.length - tagged, explorerCheckFile: explorerFile }
      : {}),
    summaryByReason: output.summaryByReason,
  }
  console.log("Filter-check completed:", report)
  return report
}
