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
import { humanizeAmount } from "./transaction-sender"

const normalizer = 1_000_000_000 // used to turn weights onto bignumbers

const contractWeight = (contract: ContractInfo): number => {
  // better distribution
  // const weight = Math.sqrt(Number(contract.gasUsed))
  const weight = contract.gasUsed
  return weight
}

type ClassRewardsGenerator = {
  contracts: ContractInfo[]
  stipend: BigNumber
  totalWeight: number
}

const allClassRewards = ({
  contracts,
  stipend,
  totalWeight,
}: ClassRewardsGenerator): Reward[] => {
  const rewards: Reward[] = contracts.map((contract) => {
    const weight = contractWeight(contract)
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

const allRewards = (
  contracts: ContractInfo[],
  stipend: BigNumber,
  newTagRatio: number
): Reward[] => {
  type Weights = { totalWeight: number; totalNewTagWeight: number }
  const { totalWeight, totalNewTagWeight }: Weights = contracts.reduce(
    (acc: Weights, contract) => {
      const { totalWeight, totalNewTagWeight } = acc
      const weight = contractWeight(contract)
      if (contract.newTag) {
        return {
          totalWeight: totalWeight + weight,
          totalNewTagWeight: totalNewTagWeight + weight,
        }
      } else {
        return { totalWeight: totalWeight + weight, totalNewTagWeight }
      }
    },
    { totalWeight: 0, totalNewTagWeight: 0 } as Weights
  )

  // check if new tags are over the ratio.
  const actualRatio = totalNewTagWeight / totalWeight
  console.log("Ratio between Kleros tags", actualRatio)
  console.log("vs newTagRatio", newTagRatio)
  let rewards: Reward[] = []
  if (actualRatio > newTagRatio) {
    // distribute as before
    console.log("Regular distribution")
    rewards = allClassRewards({ contracts, stipend, totalWeight })
  } else {
    // distribute, guaranteeing newTagRatio to the newTag class
    console.log("Giving more weight to newly submitted addresses")
    const newTaggedGenerator: ClassRewardsGenerator = {
      contracts: contracts.filter((contract) => contract.newTag),
      stipend: stipend
        .mul(BigNumber.from(Math.floor(newTagRatio * normalizer)))
        .div(BigNumber.from(normalizer)),
      totalWeight: totalNewTagWeight,
    }
    const previouslyTaggedGenerator: ClassRewardsGenerator = {
      contracts: contracts.filter((contract) => !contract.newTag),
      stipend: stipend
        .mul(BigNumber.from(Math.floor((1 - newTagRatio) * normalizer)))
        .div(BigNumber.from(normalizer)),
      totalWeight: totalWeight - totalNewTagWeight,
    }

    const newTaggedRewards = allClassRewards(newTaggedGenerator)
    const previouslyTaggedRewards = allClassRewards(previouslyTaggedGenerator)

    rewards = [...newTaggedRewards, ...previouslyTaggedRewards]
  }

  return rewards
}

export const buildRewards = async (
  period: Period,
  stipend: BigNumber,
  newTagRatio = 0
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  const tagsBatch = await fetchTagsBatch(period)
  console.log("Tag count:", tagsBatch.length)
  const contractInfos = await getAllContractInfo(tagsBatch)
  const rewards = allRewards(contractInfos, stipend, newTagRatio)
  return rewards
}
