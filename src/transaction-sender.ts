import { BigNumber, Contract, ethers } from "ethers"
import ERC20Abi from "../abi/ERC20.json"
import conf from "./config"
import { sleep } from "./spent-gas"
import { Reward } from "./types"

export const humanizeAmount = (bn: BigNumber): number => {
  return bn.div(BigNumber.from("1000000000000000")).toNumber() / 1000
}

const sendReward = async (r: Reward, nonce: number, pnk: Contract) => {
  await pnk.transfer(r.recipient, r.amount, { nonce })
}

export const sendAllRewards = async (
  rewards: Reward[],
  stipend: BigNumber,
  node: string
): Promise<void> => {
  console.info("=== Node mode:", node, "===")
  const networkId = node === "production" ? 100 : 77
  const providerUrl =
    node === "production" ? conf.TX_PROVIDER : conf.TX_TEST_PROVIDER
  const pnkAddress = node === "production" ? conf.PNK : conf.TEST_PNK

  const provider = new ethers.providers.JsonRpcProvider(providerUrl, networkId)
  const wallet = new ethers.Wallet(conf.WALLET_PRIVATE_KEY, provider)

  const pnkContract = new ethers.Contract(pnkAddress, ERC20Abi)
  const pnk = pnkContract.connect(wallet)
  console.info("=== About to send rewards ===")
  const balance: BigNumber = await pnk.balanceOf(wallet.address)
  console.info("Current balance", humanizeAmount(balance), "PNK")
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
    await sendReward(reward, nonce, pnk)
    await sleep(10) //somethings wrong with the nonce
    nonce = nonce + 1
  }
}
