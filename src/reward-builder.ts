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
import { ContractInfo, Period, Reward } from "./types"
import { BigNumber } from "ethers"

const contractWeight = (contract: ContractInfo): number => {
  // better distribution
  // const weight = Math.sqrt(Number(contract.gasUsed))
  const weight = contract.gasUsed
  return weight
}

const allRewards = (
  contracts: ContractInfo[],
  stipend: BigNumber
): Reward[] => {
  const totalWeight = contracts.reduce((acc, contract) => {
    const weight = contractWeight(contract)
    return acc + weight
  }, 0)
  const rewards: Reward[] = contracts.map((contract) => {
    const weight = contractWeight(contract)
    const normalizer = 1_000_000_000 // used to turn weights onto bignumbers
    const rewardAmount = stipend
      .mul(BigNumber.from(Math.floor(weight * normalizer)))
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

export const buildRewards = async (period: Period, stipend: BigNumber) => {
  const tagsBatch = await fetchTagsBatch(period)
  const contractInfos = await getAllContractInfo(tagsBatch)
  const rewards = allRewards(contractInfos, stipend)
  return rewards
}
