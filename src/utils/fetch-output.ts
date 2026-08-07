import { createObjectCsvWriter } from "csv-writer"
import { writeFileSync } from "fs"
import conf from "../config"
import { EnrichedTag, FetchManifest, GasDune, GenerateInput, Period, Tag } from "../types"
import { ensureFilesDir, formatRegistry } from "./output-helpers"

const toGasEntryAddress = (tagAddress: string, namespaceId: string): string => {
  if (namespaceId === "eip155") {
    return tagAddress.toLowerCase().replace(/^0x/i, "")
  }
  return tagAddress
}

const buildGasFileRows = (tags: EnrichedTag[]): GasDune[] => {
  const bag: { [key: string]: GasDune } = {}
  for (const tag of tags) {
    const key = `${tag.chain}:${tag.namespaceId === "eip155" ? tag.tagAddress.toLowerCase() : tag.tagAddress}`
    if (!bag[key]) {
      bag[key] = {
        chain: tag.chain,
        address: toGasEntryAddress(tag.tagAddress, tag.namespaceId),
        tx_count: tag.txCount,
      }
    }
  }
  return Object.values(bag)
}

export const writeFetchOutputs = async (
  runId: string,
  enrichedTags: EnrichedTag[],
  droppedBySolanaHoldersCount = 0,
  period?: Period
): Promise<FetchManifest> => {
  ensureFilesDir()

  const fullCsvFile = `${runId}_full.csv`
  const fullJsonFile = `${runId}_full.json`
  const generateInputFile = `${runId}_generate_input.json`
  const generateTagsFile = `${runId}_generate_tags.json`
  const generateGasFile = `${runId}_generate_gas.json`
  const manifestFile = `${runId}_fetch_manifest.json`
  const latestManifestFile = "latest_fetch_manifest.json"

  const csvWriter = createObjectCsvWriter({
    path: `./${conf.FILES_DIR}/${fullCsvFile}`,
    header: [
      { id: "id", title: "Item ID" },
      { id: "submitter", title: "Submitter" },
      { id: "registry", title: "Registry" },
      { id: "chain", title: "Chain ID" },
      { id: "chainCaip2", title: "Chain_CAIP2" },
      { id: "namespaceId", title: "Chain Namespace" },
      { id: "tagAddress", title: "Address tagged" },
      { id: "latestRequestResolutionTimeIso", title: "Registered at" },
      { id: "addressTagName", title: "Address Tag Name (registry)" },
      { id: "txCount", title: "txn count" },
    ],
  })

  const rows = enrichedTags.map((tag) => ({
    ...tag,
    registry: formatRegistry(tag.registry),
    latestRequestResolutionTimeIso: new Date(
      tag.latestRequestResolutionTime * 1000
    ).toISOString(),
  }))
  await csvWriter.writeRecords(rows)

  writeFileSync(
    `./${conf.FILES_DIR}/${fullJsonFile}`,
    JSON.stringify(enrichedTags, null, 2),
    { encoding: "utf-8" }
  )

  const generateTags: Tag[] = enrichedTags.map((tag) => ({
    id: tag.id,
    registry: tag.registry,
    chain: tag.chain,
    submitter: tag.submitter,
    tagAddress: tag.tagAddress,
    latestRequestResolutionTime: tag.latestRequestResolutionTime,
    isTokenOnAddressTags: tag.isTokenOnAddressTags,
    addressTagName: tag.addressTagName,
  }))
  writeFileSync(
    `./${conf.FILES_DIR}/${generateTagsFile}`,
    JSON.stringify(generateTags, null, 2),
    { encoding: "utf-8" }
  )

  const gasRows = buildGasFileRows(enrichedTags)
  writeFileSync(
    `./${conf.FILES_DIR}/${generateGasFile}`,
    JSON.stringify(gasRows, null, 2),
    { encoding: "utf-8" }
  )

  const generateInput: GenerateInput = {
    tags: generateTags,
    gas: gasRows,
  }
  writeFileSync(
    `./${conf.FILES_DIR}/${generateInputFile}`,
    JSON.stringify(generateInput, null, 2),
    { encoding: "utf-8" }
  )

  const manifest: FetchManifest = {
    runId,
    generatedAt: new Date().toISOString(),
    periodStart: period ? period.start.toISOString() : undefined,
    periodEnd: period ? period.end.toISOString() : undefined,
    fullCsvFile,
    fullJsonFile,
    generateInputFile,
    generateTagsFile,
    generateGasFile,
    includedCount: enrichedTags.length,
    droppedBySolanaHoldersCount,
  }
  writeFileSync(
    `./${conf.FILES_DIR}/${manifestFile}`,
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8" }
  )
  writeFileSync(
    `./${conf.FILES_DIR}/${latestManifestFile}`,
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8" }
  )

  return manifest
}
