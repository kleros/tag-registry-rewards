import { BigNumber } from "ethers"

export interface Prop {
  value: string
}

export interface Item {
  id: string
  latestRequestResolutionTime: string
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
  fullCsvFile: string
  fullJsonFile: string
  generateInputFile?: string
  generateTagsFile: string
  generateGasFile: string
  includedCount: number
  excludedCount?: number
  droppedBySolanaHoldersCount?: number
}

export interface GenerateInput {
  tags: Tag[]
  gas: GasDune[]
}

export type FilterCheckReason =
  | "chain not configured for rewards"
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
}

export interface FilterCheckReport {
  runId: string
  csvFile: string
  excludedCount: number
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
