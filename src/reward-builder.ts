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
      nonEditGasCount: number // used to compute the nonedit gas average
      nonEditItemCount: number // used to compute the nonedit gas average
      finalGasCount: number // nonEditGasCount + sum of min(average_non_edit, edited_item_gas)
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
      counter[ci.registry][ci.chain] = {
        itemCount: 0,
        gasCount: 0,
        nonEditGasCount: 0,
        nonEditItemCount: 0,
        finalGasCount: 0,
      }
    }
    counter[ci.registry][ci.chain].itemCount++
    counter[ci.registry][ci.chain].gasCount += ci.gasUsed
    counter[ci.registry][ci.chain].nonEditGasCount += ci.edit ? 0 : ci.gasUsed
    counter[ci.registry][ci.chain].finalGasCount += ci.edit ? 0 : ci.gasUsed
    counter[ci.registry][ci.chain].nonEditItemCount += ci.edit ? 0 : 1
  }

  // set the final gas counts, you do so by adding the mins of edits.
  const registries = Object.keys(counter)
  for (const registryName of registries) {
    const registry = counter[registryName]
    const chainIds = Object.keys(registry)
    for (const chainId of chainIds) {
      let sumOfMins = 0
      const nonEditGasAverage =
        registry[chainId].nonEditGasCount / registry[chainId].nonEditItemCount
      for (const ci of contractInfos.filter(
        (c) =>
          c.chain === Number(chainId) && c.registry === registryName && c.edit
      )) {
        sumOfMins += Math.min(nonEditGasAverage, ci.gasUsed)
      }
      registry[chainId].finalGasCount += sumOfMins
    }
  }
  return counter
}

const editRewards = (
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

    const getGasReward = () => {
      // if edit, only up to the average
      const effectiveGas = contract.edit
        ? Math.min(contract.gasUsed, counter.finalGasCount / counter.itemCount)
        : contract.gasUsed
      const gasReward =
        // counter.finalGasCount could be zero. in that case, just assign the unitaryReward.
        counter.finalGasCount > 0
          ? gasStipend
              .mul(BigNumber.from(Math.floor(effectiveGas * normalizer)))
              .div(
                BigNumber.from(Math.floor(counter.finalGasCount * normalizer))
              )
          : unitaryReward
      return gasReward
    }

    const totalReward = unitaryReward.add(getGasReward())

    const weight =
      totalReward.mul(normalizer).div(stipend).toNumber() / normalizer

    const reward: Reward = {
      id: contract.id,
      amount: totalReward,
      weight: weight,
      recipient: contract.submitter,
      contractInfo: contract,
      edit: contract.edit,
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
  const rewards = editRewards(contractInfos, stipend)

  let sum = BigNumber.from(0)
  for (const reward of rewards) {
    sum = sum.add(reward.amount)
  }
  console.log("Final PNK stipend", sum.toString())
  return rewards
}
