import { createObjectCsvWriter } from "csv-writer"
import conf from "../config"
import { ExplorerReview, FilterCheckReason, FilterCheckRow } from "../types"
import { ensureFilesDir, formatRegistry } from "./output-helpers"

// Every FilterCheckReason (the compiler enforces it), in the order the
// filters apply them: the order of the summary rows.
const REASON_SUMMARY_ORDER: { [reason in FilterCheckReason]: true } = {
  "chain not configured for rewards": true,
  "token on address tags": true,
  "prediction market outcome token": true,
  "not a contract (getCode == 0x)": true,
  "eip-1167 minimal proxy": true,
  "erc-721 contract": true,
}
const REASON_ORDER = Object.keys(REASON_SUMMARY_ORDER) as FilterCheckReason[]

type CsvRow = {
  rowType: "detail" | "summary"
  exclusionReason: string
  excludedCount: string
  id: string
  submitter: string
  registry: string
  chain: string
  tagAddress: string
  latestRequestResolutionTimeIso: string
  detail: string
}

// The explorer check's findings, for review (see explorer-tags.ts): entries
// tagged on their explorer, then those whose explorer could not be read.
// `<runId>_explorer_check.csv`, or null when there is nothing to review.
export const writeExplorerCheck = async (runId: string, reviews: ExplorerReview[]): Promise<string | null> => {
  if (reviews.length === 0) return null
  ensureFilesDir()
  const csvFile = `${runId}_explorer_check.csv`
  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${csvFile}`,
    header: [
      { id: "status", title: "Explorer" },
      { id: "id", title: "Item ID" },
      { id: "submitter", title: "Submitter" },
      { id: "registry", title: "Registry" },
      { id: "chain", title: "Chain ID" },
      { id: "tagAddress", title: "Address tagged" },
      { id: "registeredAt", title: "Registered at" },
      { id: "url", title: "Explorer page" },
      { id: "detail", title: "Tags there, or why not read" },
    ],
  })
  const ordered = reviews.filter((r) => r.status === "tagged").concat(reviews.filter((r) => r.status !== "tagged"))
  await csvWriter.writeRecords(
    ordered.map(({ tag, status, url, detail }) => ({
      status,
      id: tag.id,
      submitter: tag.submitter,
      registry: formatRegistry(tag.registry),
      chain: tag.chain,
      tagAddress: tag.tagAddress,
      registeredAt: new Date(tag.latestRequestResolutionTime * 1000).toISOString(),
      url,
      detail,
    }))
  )
  return csvFile
}

export const writeFilterCheckOutput = async (
  runId: string,
  excludedRows: FilterCheckRow[]
): Promise<{
  csvFile: string
  summaryByReason: Array<{ reason: FilterCheckReason; count: number }>
}> => {
  ensureFilesDir()

  const csvFile = `${runId}_filter_check.csv`
  const summaryByReason = REASON_ORDER.map((reason) => ({
    reason,
    count: excludedRows.filter((row) => row.reason === reason).length,
  }))

  const detailRows: CsvRow[] = excludedRows.map((row) => ({
    rowType: "detail",
    exclusionReason: row.reason,
    excludedCount: "",
    id: row.id,
    submitter: row.submitter,
    registry: formatRegistry(row.registry),
    chain: row.chain,
    tagAddress: row.tagAddress,
    latestRequestResolutionTimeIso: new Date(
      row.latestRequestResolutionTime * 1000
    ).toISOString(),
    detail: row.detail || "",
  }))

  const summaryRows: CsvRow[] = [
    {
      rowType: "summary",
      exclusionReason: "TOTAL EXCLUDED",
      excludedCount: String(excludedRows.length),
      id: "",
      submitter: "",
      registry: "",
      chain: "",
      tagAddress: "",
      latestRequestResolutionTimeIso: "",
      detail: "",
    },
    ...summaryByReason.map((item) => ({
      rowType: "summary" as const,
      exclusionReason: item.reason,
      excludedCount: String(item.count),
      id: "",
      submitter: "",
      registry: "",
      chain: "",
      tagAddress: "",
      latestRequestResolutionTimeIso: "",
      detail: "",
    })),
  ]

  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${csvFile}`,
    header: [
      { id: "rowType", title: "Row Type" },
      { id: "exclusionReason", title: "Exclusion reason" },
      { id: "excludedCount", title: "Excluded count" },
      { id: "id", title: "Item ID" },
      { id: "submitter", title: "Submitter" },
      { id: "registry", title: "Registry" },
      { id: "chain", title: "Chain ID" },
      { id: "tagAddress", title: "Address tagged" },
      { id: "latestRequestResolutionTimeIso", title: "Registered at" },
      { id: "detail", title: "Detail" },
    ],
  })

  await csvWriter.writeRecords([...detailRows, ...summaryRows])

  return {
    csvFile,
    summaryByReason,
  }
}

