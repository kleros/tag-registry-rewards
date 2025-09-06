import { generateContractInfos } from "./contract-info"
import { ContractInfo, GasDune, Reward, Tag } from "./types"
import { BigNumber } from "ethers"
import { humanizeAmount } from "./transaction-sender"
import { formatEther } from "ethers/lib/utils"

const normalizer = 1_000_000 // used to turn weights onto bignumbers

const contractInfosToRewards = (
  contractInfos: ContractInfo[],
  stipend: BigNumber,
  maxReward: BigNumber,
  registryName?: string
): Reward[] => {
  // base case
  if (contractInfos.length === 0) return []
  const registryLabel = registryName ? ` (${registryName} registry)` : ""
  console.log(
    `pending recursion... ${contractInfos.length} submissions${registryLabel}, stipend remaining:`,
    formatEther(stipend.toString())
  )
  const counter = { itemCount: 0, txCount: 0 }
  for (const ci of contractInfos) {
    counter.itemCount++
    counter.txCount += ci.txCount
  }

  const rewards = contractInfos.map((ci) => {
    const unitaryStipend = counter.txCount === 0 ? stipend : stipend.div(BigNumber.from(2))
    const unitaryReward = unitaryStipend.div(BigNumber.from(counter.itemCount))
    const txStipend = counter.txCount === 0 ? BigNumber.from(0) : stipend.div(BigNumber.from(2))
    const txReward = counter.txCount === 0 
      ? BigNumber.from(0)
      : txStipend
          .mul(BigNumber.from(ci.txCount))
          .mul(BigNumber.from(normalizer))
          .div(BigNumber.from(counter.txCount))
          .div(BigNumber.from(normalizer))

    const totalReward = unitaryReward.add(txReward)
    const reward: Reward = {
      id: ci.id,
      amount: totalReward,
      recipient: ci.submitter,
      contractInfo: ci,
    }
    return reward
  })

  const excessiveRewards = rewards.filter((r) => r.amount.gte(maxReward))
  if (excessiveRewards.length === 0) return rewards
  // console.log("still excessive:", excessiveRewards.length)
  // put in a bag all contractInfos whose id is not found in excessiveRewards
  // if [], that base case is covered
  const lessAwardedContracts = contractInfos.filter(
    (ci) => !excessiveRewards.find((r) => r.id === ci.id)
  )
  // console.log("pending", lessAwardedContracts.length)
  // put in a bag all excessive rewards, capped to maxReward
  const cappedRewards = excessiveRewards.map((r) => ({
    ...r,
    amount: maxReward,
  }))
  // recompute this function, with the subset of less awarded contracts, and less stipend
  const newStipend = stipend.sub(
    maxReward.mul(BigNumber.from(cappedRewards.length))
  )
  const lesserRewards = contractInfosToRewards(
    lessAwardedContracts,
    newStipend,
    maxReward
  )
  return [...cappedRewards, ...lesserRewards]
}

export const buildRewards = async (
  stipend: BigNumber,
  maxReward: BigNumber,
  tags: Tag[],
  gasDunes: GasDune[]
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  const contractInfos = generateContractInfos(tags, gasDunes)

  const tagRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "addressTags"),
    stipend,
    maxReward,
    "addressTags"
  )
  const tokensRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "tokens"),
    stipend,
    maxReward,
    "tokens"
  )
  const domainsRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "domains"),
    stipend,
    maxReward,
    "domains"
  )
  const rewards = [...tagRewards, ...tokensRewards, ...domainsRewards]
  let sum = BigNumber.from(0)
  for (const reward of rewards) {
    sum = sum.add(reward.amount)
  }
  console.log("Final PNK stipend", sum.toString())
  return rewards
}
