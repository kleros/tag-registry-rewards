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
  metadata : { 
    props: Prop[]
    key0: string
    key1: string
    key2: string
    key3: string
  } | null
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
