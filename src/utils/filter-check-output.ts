import { createObjectCsvWriter } from "csv-writer"
import conf from "../config"
import { FilterCheckReason, FilterCheckRow } from "../types"
import { ensureFilesDir, formatRegistry } from "./output-helpers"

const REASON_ORDER: FilterCheckReason[] = [
  "chain not configured for rewards",
  "already tagged on explorer",
  "not a contract (getCode == 0x)",
  "eip-1167 minimal proxy",
  "erc-721 contract",
]

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
    ],
  })

  await csvWriter.writeRecords([...detailRows, ...summaryRows])

  return {
    csvFile,
    summaryByReason,
  }
}

