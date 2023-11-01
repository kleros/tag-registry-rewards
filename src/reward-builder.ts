import { generateContractInfos } from "./contract-info"
import { ContractInfo, GasDune, Reward, Tag } from "./types"
import { BigNumber } from "ethers"
import { humanizeAmount } from "./transaction-sender"

const normalizer = 1_000_000 // used to turn weights onto bignumbers

interface CounterMap {
  [registry: string]: {
    [chainId: string]: {
      itemCount: number
      gasCount: number
    }
  }
}

const buildCounts = (contractInfos: ContractInfo[]): CounterMap => {
  const counter: CounterMap = {}
  for (const ci of contractInfos) {
    if (counter[ci.registry] === undefined) {
      counter[ci.registry] = {}
    }
    if (counter[ci.registry][ci.chain] === undefined) {
      counter[ci.registry][ci.chain] = { itemCount: 0, gasCount: 0 }
    }
    counter[ci.registry][ci.chain].itemCount++
    counter[ci.registry][ci.chain].gasCount += ci.gasUsed
  }
  return counter
}

const allRewards = (
  contractInfos: ContractInfo[],
  stipend: BigNumber
): Reward[] => {
  const counterMap = buildCounts(contractInfos)
  console.log("Check out the counts:")
  console.log(counterMap)
  console.log("---------------")
  console.log("Generating rewards...")
  const unitaryStipend = stipend.div(2)
  const gasStipend = stipend.div(2)

  const rewards = contractInfos.map((contract) => {
    const counter = counterMap[contract.registry][contract.chain]
    const unitaryReward = unitaryStipend.div(
      BigNumber.from(Math.floor(counter.itemCount))
    )

    // counter.gasCount could be zero. in that case, just assign the unitaryReward.
    const gasReward =
      counter.gasCount > 0
        ? gasStipend
            .mul(BigNumber.from(Math.floor(contract.gasUsed * normalizer)))
            .div(BigNumber.from(Math.floor(counter.gasCount * normalizer)))
        : unitaryReward

    const totalReward = unitaryReward.add(gasReward)

    const weight =
      totalReward.mul(normalizer).div(stipend).toNumber() / normalizer

    const reward: Reward = {
      id: contract.id,
      amount: totalReward,
      weight: weight,
      recipient: contract.submitter,
      contractInfo: contract,
    }
    return reward
  })

  return rewards
}

export const buildRewards = async (
  stipend: BigNumber,
  tags: Tag[],
  gasDunes: GasDune[]
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  const contractInfos = generateContractInfos(tags, gasDunes)
  const rewards = allRewards(contractInfos, stipend)
  return rewards
}
