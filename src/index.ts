import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"

const start = new Date(Date.UTC(2022, 3, 11))
const end = new Date(Date.UTC(2022, 4, 1))

const stipend = BigNumber.from("100000000000000000000000")
buildRewards({start, end}, stipend).then(p => {
  console.log(p)
  console.log(p.length)
  const viewable = p.map(reward => {
    return reward.amount.div(BigNumber.from("1000000000000000000")).toNumber()
  })
  console.log(viewable)
})
