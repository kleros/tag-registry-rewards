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
  requests: {requester: string}[]
}

export type Period = {
  start: Date,
  end: Date
}

export interface Tag {
  id: string
  submitter: string
  tagAddress: string
  latestRequestResolutionTime: number
}

export interface ContractInfo extends Tag {
  gasUsed: number
  newTag: boolean
}

export interface Reward {
  contractInfo: ContractInfo,
  amount: BigNumber
  recipient: string
  id: string // used to identify dupes
}