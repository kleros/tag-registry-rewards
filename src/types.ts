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
  start: number,
  end: number
}

export interface Tag {
  id: string
  submitter: string
  tagAddress: string
  latestRequestResolutionTime: number
}

export interface ContractInfo extends Tag {
  gasUsed: string
}

export interface Reward {
  amount: string // prob BigNumberish?
  recipient: string
  id: string // used to identify dupes
}