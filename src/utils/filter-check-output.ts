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
  "erc-20 contract": true,
  "answers any call (catch-all)": true,
  "solana token mint": true,
  "tagged on explorer before submission": true,
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

// The explorer check's findings (see explorer-tags.ts and tag-dating.ts):
// entries tagged on their explorer today, then those whose explorer could not
// be read, each with the dated check's verdict and evidence when it applies
// (excluded, kept, or paid by default). `<runId>_explorer_check.csv`, or null
// when there is nothing to list.
export const writeExplorerCheck = async (runId: string, reviews: ExplorerReview[]): Promise<string | null> => {
  if (reviews.length === 0) return null
  ensureFilesDir()
  const csvFile = `${runId}_explorer_check.csv`
  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${csvFile}`,
    header: [
      { id: "status", title: "Explorer" },
      { id: "decision", title: "Decision" },
      { id: "id", title: "Item ID" },
      { id: "submitter", title: "Submitter" },
      { id: "registry", title: "Registry" },
      { id: "chain", title: "Chain ID" },
      { id: "tagAddress", title: "Address tagged" },
      { id: "submittedAt", title: "Submitted at" },
      { id: "registeredAt", title: "Registered at" },
      { id: "url", title: "Explorer page" },
      { id: "detail", title: "Tags there, or why not read" },
      { id: "evidence", title: "Evidence" },
    ],
  })
  const ordered = reviews.filter((r) => r.status === "tagged").concat(reviews.filter((r) => r.status !== "tagged"))
  await csvWriter.writeRecords(
    ordered.map(({ tag, status, url, detail, decision, evidence }) => ({
      status,
      decision: decision || "to review by hand",
      id: tag.id,
      submitter: tag.submitter,
      registry: formatRegistry(tag.registry),
      chain: tag.chain,
      tagAddress: tag.tagAddress,
      submittedAt: tag.submissionTime ? new Date(tag.submissionTime * 1000).toISOString() : "",
      registeredAt: new Date(tag.latestRequestResolutionTime * 1000).toISOString(),
      url,
      detail,
      evidence: evidence || "",
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

