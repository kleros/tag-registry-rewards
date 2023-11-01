import { BigNumber } from "ethers"

export interface Prop {
  value: string
}

export interface Item {
  props: Prop[]
  id: string
  latestRequestResolutionTime: string
  registryAddress?: string
  status?: string
  requests: ItemRequest[]
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
  chain: number
  submitter: string
  tagAddress: string
  latestRequestResolutionTime: number
}

export interface GasDune {
  chain: number
  address: string
  gas_spent: number
}

export interface ContractInfo extends Tag {
  gasUsed: number
}

export interface Reward {
  contractInfo: ContractInfo
  amount: BigNumber
  weight: number
  recipient: string
  id: string // used to identify dupes
}

export interface Transaction {
  amount: BigNumber
  recipient: string
}

export interface Registry {
  "1": Tag[]
  "56": Tag[]
  "100": Tag[]
  "137": Tag[]
}

export interface TagBucket {
  addressTags: Registry
  tokens: Registry
  domains: Registry
}
