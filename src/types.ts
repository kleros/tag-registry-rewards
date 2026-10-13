import { BigNumber } from "ethers"

export interface Prop {
  value: string
}

export interface Item {
  id: string
  itemID?: string
  latestRequestResolutionTime: string
  latestRequestSubmissionTime?: string
  numberOfRequests?: number
  registryAddress?: string
  status?: string
  requests: ItemRequest[]
  props: Prop[]
  key0: string
  key1: string
  key2: string
  key3: string
}

export interface ItemRequest {
  requester: string
  requestType: "RegistrationRequested" | "ClearingRequested"
  resolutionTime: number
  submissionTime?: number
}

export type Period = {
  start: Date
  end: Date
}

export interface Tag {
  id: string
  registry: "addressTags" | "tokens" | "domains"
  chain: string
  submitter: string
  tagAddress: string
  latestRequestResolutionTime: number
  isTokenOnAddressTags: boolean
  addressTagName: string
}

export interface ChainConfig {
  id: string
  namespaceId: "eip155" | "solana"
  name: string
  label: string
  explorer: string
  rpc: string
}

export interface EnrichedTag extends Tag {
  chainCaip2: string
  namespaceId: "eip155" | "solana"
  txCount: number
}

export interface FetchManifest {
  runId: string
  generatedAt: string
  // Period the tags were fetched for (absent in manifests from older runs).
  periodStart?: string
  periodEnd?: string
  fullCsvFile: string
  fullJsonFile: string
  generateInputFile?: string
  generateTagsFile: string
  generateGasFile: string
  includedCount: number
  excludedCount?: number
  droppedBySolanaHoldersCount?: number
  // Where the tx counts came from (absent in manifests from older runs).
  enrichment?: FetchEnrichmentInfo
  // The explorer check's findings to review (see utils/explorer-tags.ts), when any.
  explorerCheck?: { file: string; tagged: number; notRead: number }
}

export interface FetchEnrichmentInfo {
  startedAt: string
  finishedAt: string
  evm: {
    provider: string
    definition: string
    cacheDir?: string
    chains?: Array<{
      chainId: string
      toBlockExclusive: number
      archiveHeight: number
      addresses: number
      invalidAddresses: string[]
      scannedAddresses: number
      rows: number
      requests: number
      elapsedMs: number
      preByzantiumNullStatusRows?: number
      note?: string
    }>
  }
  solana: {
    provider: string
    definition: string
    holdersDefinition?: string
    endpoints?: string[]
    pages?: number
    cacheDir?: string
    addresses?: Array<{
      address: string
      registries: string[]
      method: string
      successful: number
      failed: number
      holders?: number
      holdersSource?: string
    }>
  }
}

export interface GenerateInput {
  tags: Tag[]
  gas: GasDune[]
}

export type FilterCheckReason =
  | "chain not configured for rewards"
  | "token on address tags"
  | "prediction market outcome token"
  | "not a contract (getCode == 0x)"
  | "eip-1167 minimal proxy"
  | "erc-721 contract"

export interface FilterCheckRow {
  id: string
  submitter: string
  registry: Tag["registry"]
  chain: string
  tagAddress: string
  latestRequestResolutionTime: number
  reason: FilterCheckReason
  // The evidence: the explorer's name tag, the prediction market…
  detail?: string
}

// An Address Tags or Tokens entry as its reference explorer shows it: tagged
// there (with the tags), or an explorer that could not be read (a Cloudflare
// challenge, Solscan). Reported for review, never excluded automatically: no
// explorer tells when a tag was added, nor whether it came from Kleros Scout
// itself (see explorer-tags.ts); a confirmed one goes to exclusions.json.
export interface ExplorerReview {
  tag: Tag
  status: "tagged" | "not read"
  url: string
  detail: string // the tags, or why the explorer was not read
}

export interface FilterCheckReport {
  runId: string
  csvFile: string
  excludedCount: number
  // the explorer check: entries tagged there, explorers not read, the file
  explorerTaggedCount?: number
  explorerNotReadCount?: number
  explorerCheckFile?: string
  summaryByReason: Array<{ reason: FilterCheckReason; count: number }>
}

export interface GasDune {
  chain: string
  address: string
  tx_count: number
}

export interface ContractInfo extends Tag {
  txCount: number
}

export interface Reward {
  contractInfo: ContractInfo
  amount: BigNumber
  recipient: string
  id: string // used to identify dupes
}

export interface Transaction {
  amount: BigNumber
  recipient: string
}

// A confirmed removal (item removed within the period), rewarding the remover.
export interface Removal {
  id: string
  itemID: string
  registry: Tag["registry"]
  chain: string
  chainName: string
  submitter: string // the remover: requester of the winning ClearingRequested
  tagAddress: string
  removedAt: number // unix seconds of the removal (resolution time)
}

export interface RemovalReward {
  removal: Removal
  amount: BigNumber
  recipient: string
  id: string
}

export type AtqReportKind = "registered" | "absent"

export interface AtqRow {
  itemID: string
  submissionTime: number
  resolutionTime: number
  requester: string
  metadata: string
}

// A rewarded ATQ event (a registration or a removal in the ATQ registry).
export interface AtqReward {
  recipient: string
  id: string
  kind: "registered" | "removed"
  itemID: string
  metadata: string
  amount: BigNumber
}

// Serializable, breakdown-rich reward record shared by the documentation step.
export interface RewardRecord {
  recipient: string
  id: string
  registry: Tag["registry"]
  chain: string
  chainName: string
  tagAddress: string
  amount: string // PNK wei, decimal string
}

export interface GenerateManifest {
  runId: string
  generatedAt: string
  // Period of the fetch the rewards came from, and its files (absent in
  // manifests from older runs, or when the period could not be told).
  periodStart?: string
  periodEnd?: string
  tagsFile?: string
  gasFile?: string
  // The REWARD_FORMULA_* settings the rewards were computed with (they change
  // between periods: the Tokens weighting did from October 2026).
  formulas?: { addressTags: string; tokens: string; domains: string }
  rewardsFile: string
  transactionsFile: string
}

// One reward line (submission, removal, or ATQ) inside a per-recipient entry.
// `registry` is a string to allow the "atq" source alongside the three registries.
export interface CurateRewardLine {
  registry: string
  chain: string
  chainName: string
  tagAddress: string
  amount: string // PNK wei
}

export interface CurateRecipient {
  total: string // PNK wei
  submissions: CurateRewardLine[]
  removals: CurateRewardLine[]
  atq: CurateRewardLine[]
}

// The structured per-period document uploaded to IPFS and read by the page.
export interface CurateSnapshot {
  schema: "curate-rewards/v1"
  period: { label: string; start: string; end: string }
  generatedAt: string
  chainId: number
  token: { symbol: string; address: string }
  totals: {
    submissions: string
    removals: string
    atq: string
    total: string
    recipientCount: number
  }
  // Rewarded entries per category (one reward record = one entry). The
  // published back-catalog carries these since the 2026-07-20 amendment, and
  // the rewards dashboard prefers them over counting itemized lines.
  entryCounts: {
    submissions: number
    removals: number
    atq: number
    total: number
  }
  recipients: { [address: string]: CurateRecipient }
  note: string
}

export interface CurateIndexEntry {
  period: string
  cid: string | null
  url: string | null
  file: string
  generatedAt: string
  total: string
  recipientCount: number
}

// Serializable ATQ reward record (wei string), read by the documentation step.
export interface AtqRewardRecord {
  recipient: string
  id: string
  kind: "registered" | "removed"
  itemID: string
  metadata: string
  amount: string // PNK wei
}

export interface RemovalsManifest {
  runId: string
  generatedAt: string
  periodStart: string
  periodEnd: string
  removalsCsvFile: string
  removalsJsonFile: string
  transactionsFile: string
  transactionsCsvFile: string
  atqRegisteredCsvFile: string
  atqAbsentCsvFile: string
  atqRewardsJsonFile: string
  atqTransactionsFile: string
  atqTransactionsCsvFile: string
  removalCount: number
  atqRegisteredCount: number
  atqAbsentCount: number
  atqRewardCount: number
}
