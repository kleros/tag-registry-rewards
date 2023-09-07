import { getAllContractInfo } from "./contract-info"
import { fetchTags } from "./tag-fetch"
import { ContractInfo, Period, Reward } from "./types"
import { BigNumber } from "ethers"
import { humanizeAmount } from "./transaction-sender"
import { writeFileSync } from "fs"
import conf from "./config"

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
  period: Period,
  stipend: BigNumber
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  console.log("Period:", period)
  const tags = await fetchTags(period)
  console.log("Tag count:")

  console.log("A.T.", tags.filter((t) => t.registry === "addressTags").length)
  console.log("Tokens", tags.filter((t) => t.registry === "tokens").length)
  console.log("Domains", tags.filter((t) => t.registry === "domains").length)

  const contractInfos = await getAllContractInfo(tags) //todo de debug

  const filename = new Date().getTime()
  writeFileSync(
    `./${conf.FILES_DIR}/contracts-${filename}.json`,
    JSON.stringify(contractInfos)
  )
  const rewards = allRewards(contractInfos, stipend)
  return rewards
}
