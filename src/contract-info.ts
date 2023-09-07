import { getSpentGas } from "./spent-gas"
import { ContractInfo, Tag } from "./types"
import promptSyncThing from "prompt-sync"
import Web3 from "web3"
import conf from "./config"

const prompt = promptSyncThing()

// only used to check if something is a contract
const web3s = {
  "1": new Web3(conf.MAINNET_RPC),
  "56": new Web3(conf.BSC_RPC),
  "100": new Web3(conf.GNOSIS_RPC),
  "137": new Web3(conf.POLYGON_RPC),
}

const isContract = async (tag: Tag): Promise<boolean> => {
  const web3 = web3s[tag.chain]
  const addressCode = await web3.eth.getCode(tag.tagAddress)
  if (addressCode === "0x") return false
  return true
}

const tagToContractInfo = async (tag: Tag): Promise<ContractInfo | null> => {
  const contractCheck = await isContract(tag)
  if (!contractCheck) {
    return null
  }
  const gasUsed = await getSpentGas(tag)
  const contract: ContractInfo = { ...tag, gasUsed }
  return contract
}

// naive, sequencial execution
export const getAllContractInfo = async (
  tags: Tag[]
): Promise<ContractInfo[]> => {
  const contracts: ContractInfo[] = []
  const bscBuffer: Tag[] = []
  const gnosisBuffer: Tag[] = []
  for (const tag of tags) {
    // hack
    if (tag.chain === 100) {
      gnosisBuffer.push(tag)
      continue
    } else if (tag.chain === 56) {
      bscBuffer.push(tag)
      continue
    }
    console.info(
      "Chain",
      tag.chain,
      "Building contractInfo for tag:",
      tag.tagAddress
    )
    const contractInfo = await tagToContractInfo(tag)
    if (contractInfo) {
      console.info("gas:", contractInfo.gasUsed)
      contracts.push(contractInfo)
    } else {
      console.info("Tag wasn't a contract")
    }
  }

  // hack starts.
  console.log("Paste in the Txs Fees per prompted link.")
  for (const tag of bscBuffer) {
    console.log("------")
    const gas = prompt(
      `https://bscscan.com/address-analytics?&a=${tag.tagAddress}`
    )
    const contractInfo = { ...tag, gasUsed: Number(gas) }
    contracts.push(contractInfo)
  }
  console.log("Go to: https://gnosis.blockscout.com/graphiql")
  for (const tag of gnosisBuffer) {
    console.log("------")
    const gas = prompt(`gnosis: ${tag.tagAddress}`)
    // gnosis gas is brought down a few notches due to overflows
    const contractInfo = { ...tag, gasUsed: Number(gas) / 1_000_000 }
    contracts.push(contractInfo)
  }

  return contracts
}
