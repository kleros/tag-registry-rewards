import { BigNumber } from "ethers"

// Disbursing lives in send-routine.ts; these helpers are shared by the builders.

const randomBetween = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min))

export const sleep = (seconds = 0): Promise<void> => {
  if (seconds === 0) seconds = randomBetween(2, 5)
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export const humanizeAmount = (bn: BigNumber): number => {
  return bn.div(BigNumber.from("1000000000000000")).toNumber() / 1000
}
