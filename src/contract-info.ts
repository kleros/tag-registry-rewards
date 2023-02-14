import { getSpentGas } from "./spent-gas"
import { ContractInfo, Period, Tag } from "./types"
import Web3 from "web3"
import conf from "./config"
import { isEdit } from "./is-tag-edit"

const web3 = new Web3(conf.MAINNET_RPC)

const isContract = async (tag: Tag): Promise<boolean> => {
  const addressCode = await web3.eth.getCode(tag.tagAddress)
  if (addressCode === "0x") return false
  return true
}

const tagToContractInfo = async (tag: Tag, editPeriod: Period): Promise<ContractInfo | null> => {
  const contractCheck = await isContract(tag)
  if (!contractCheck) {
    return null
  }
  const gasUsed = await getSpentGas(tag.tagAddress)
  const edit = await isEdit(tag.tagAddress, editPeriod)
  const contract: ContractInfo = { ...tag, gasUsed, edit }
  return contract
}

// naive, sequencial execution
export const getAllContractInfo = async (
  tags: Tag[],
  editPeriod: Period
): Promise<ContractInfo[]> => {
  const contracts: ContractInfo[] = []
  for (const tag of tags) {
    console.info("Building contractInfo for tag:", tag.tagAddress)
    const contractInfo = await tagToContractInfo(tag, editPeriod)
    if (contractInfo) {
      console.info("Was contract. gas:", contractInfo.gasUsed)
      contracts.push(contractInfo)
    } else {
      console.info("Tag wasn't a contract")
    }
  }
  return contracts
}
