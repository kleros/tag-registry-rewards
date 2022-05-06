import { BigNumber, ethers } from "ethers"
import ERC20Abi from "../abi/ERC20.json"
import conf from "./config"
import { Reward } from "./types"

const network = conf.NODE_ENV === "production" ? "mainnet" : "kovan"
const provider = new ethers.providers.InfuraProvider(network, conf.TX_KEY)
const wallet = new ethers.Wallet(conf.WALLET_PRIVATE_KEY, provider)

const pnkContract = new ethers.Contract(conf.PNK, ERC20Abi)
const pnk = pnkContract.connect(wallet)

const humanizeAmount = (bn: BigNumber): number => {
  return bn.div(BigNumber.from("1000000000000000")).toNumber() / 1000
}

const sendReward = async (r: Reward, nonce: number) => {
  await pnk.transfer(r.recipient, r.amount, { nonce })
}

export const sendAllRewards = async (rewards: Reward[], stipend: BigNumber) => {
  console.info("=== About to send rewards ===")
  const balance: BigNumber = await pnk.balanceOf(wallet.address)
  console.info("Current balance", balance.toString())
  if (!balance || balance.lt(stipend)) {
    throw new Error("Balance is lower than stipend")
  }
  let nonce = await wallet.getTransactionCount()
  console.info("Nonce", nonce)

  for (const reward of rewards) {
    console.info(
      "Sending",
      humanizeAmount(reward.amount),
      "PNK to",
      reward.recipient
    )
    await sendReward(reward, nonce)
    nonce = nonce + 1
  }
}
