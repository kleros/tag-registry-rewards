/**
 * 1. get all items that are currently registered with last update in period
 * 2. if dupes in that period (e.g. submitted to both tcrs) get earliest. cast to tag
 * 3. per Tag, check contract gas usage in etherscan api. if contract, cast to ContractInfo
 * 4. figure out the weight of each ContractInfo (do sqrt of each, then store proportion)
 * 5. figure out the reward by multiplying proportion by total monthly expenditure. cast to Reward
 * 6. per Reward, send the reward, then immediately file the reward as sent in db.
 * 7. finish process.
 */

import { getAllContractInfo } from "./contract-info"
import { fetchTagsBatch } from "./tag-fetch"
import { ContractInfo, Period, Reward, WeightedContractInfo } from "./types"
import { BigNumber } from "ethers"
import { humanizeAmount } from "./transaction-sender"

const normalizer = 1_000_000_000 // used to turn weights onto bignumbers

const contractWeight = (contract: ContractInfo): number => {
  // better distribution
  // const weight = Math.sqrt(Number(contract.gasUsed))
  const weight = contract.gasUsed
  return weight
}

const allClassRewards = (
  contracts: WeightedContractInfo[],
  stipend: BigNumber,
  totalWeight: number
): Reward[] => {
  const rewards: Reward[] = contracts.map((contract) => {
    const rewardAmount = stipend
      .mul(BigNumber.from(Math.floor(contract.weight * normalizer)))
      .div(BigNumber.from(Math.floor(totalWeight * normalizer)))
    const reward: Reward = {
      id: contract.id,
      amount: rewardAmount,
      recipient: contract.submitter,
      contractInfo: contract,
    }
    return reward
  })
  return rewards
}

const allRewards = (
  contracts: ContractInfo[],
  stipend: BigNumber
): Reward[] => {
  // first we remove the edit tags from consideration.
  const nonEditContracts = contracts.filter(contract => !contract.edit)
  const weightedNonEdits: WeightedContractInfo[] =
    nonEditContracts.map(contract => ({...contract, weight: contractWeight(contract)}))

  const totalNonEditWeight = weightedNonEdits.reduce((acc, contract) => acc + contract.weight, 0)

  // edits can, at max, have the average reward of non-edited tags.
  if (nonEditContracts.length === 0) throw new Error("No new tags, edge case must be handled.")
  console.log(nonEditContracts.length, "non-edit tags")
  const averageNonEdit = totalNonEditWeight / nonEditContracts.length
  console.log("Average non-edit weight:", averageNonEdit)

  const editContracts = contracts.filter(contract => contract.edit)
  console.log(editContracts.length, "edit tags")
  const weightedEdits: WeightedContractInfo[] = editContracts
    .map(contract => ({ ...contract, weight: Math.min(contractWeight(contract), averageNonEdit) }))

  const totalEditWeight = weightedEdits.reduce((acc, contract) => acc + contract.weight, 0)

  const weightedContracts = [...weightedEdits, ...weightedNonEdits]
  const rewards = allClassRewards(weightedContracts, stipend, totalEditWeight + totalNonEditWeight)
  return rewards
}

export const buildRewards = async (
  period: Period,
  stipend: BigNumber,
  editPeriod: Period
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  console.log("Period:", period)
  const tagsBatch = await fetchTagsBatch(period)
  console.log("Tag count:", tagsBatch.length)
  const contractInfos = await getAllContractInfo(tagsBatch, editPeriod)
  const rewards = allRewards(contractInfos, stipend)
  return rewards
}
