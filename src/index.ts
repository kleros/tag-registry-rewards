import { BigNumber } from "ethers"
import { buildRewards } from "./reward-builder"
import { sendAllRewards } from "./transaction-sender"
import { Period } from "./types"
import conf from "./config"

const parseDate = (s: string): number[] => {
  const [y, m, d] = s.split("-").map((n) => Number(n))
  return [y, m, d]
}

const dstart = parseDate(conf.START_DATE)
const dend = parseDate(conf.END_DATE)
// javascript dates...
const start = new Date(Date.UTC(dstart[0], dstart[1] - 1, dstart[2]))
const end = new Date(Date.UTC(dend[0], dend[1] - 1, dend[2]))

console.log(start)
console.log(end)

const stipend = BigNumber.from(conf.STIPEND)

const main = async ({ start, end }: Period, stipend: BigNumber) => {
  const rewards = await buildRewards({ start, end }, stipend)
  await sendAllRewards(rewards, stipend)
}

main({ start, end }, stipend)
