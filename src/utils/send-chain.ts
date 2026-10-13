import { BigNumber, ethers, utils } from "ethers"
import ERC20Abi from "../../abi/ERC20.json"
import conf from "../config"
import { chains } from "./chains"
import { errorMessage } from "./runtime-helpers"

// What `send` needs from the chain: balances, nonces, signing a PNK transfer,
// broadcasting it, its receipt, and the wallet's past PNK transfers. Plain
// JSON-RPC over TX_RPC_URL (default: the chains.ts RPC of TX_NETWORK_ID);
// transactions are signed locally, so the signed bytes can be saved before
// they are broadcast.

export interface Fees {
  maxFeePerGas: BigNumber
  maxPriorityFeePerGas: BigNumber
  gasLimit: BigNumber
}

export interface Receipt {
  status: number // 1 success, 0 reverted
  blockNumber: number
}

export interface OnchainTransfer {
  to: string
  amount: string // wei
  txHash: string
  blockNumber: number
}

// accepted: the node took it. known: it already had it. nonce-too-low: the
// nonce is used (by this transaction once mined, or by another one).
// replacement-underpriced: another transaction with the same nonce is waiting
// and this one does not raise both fees enough to replace it. underpriced: the
// fee is below what the node accepts (its minimum, the base fee, a full pool).
export type BroadcastResult = "accepted" | "known" | "nonce-too-low" | "replacement-underpriced" | "underpriced"

export interface SendChain {
  readonly chainId: number
  readonly from: string
  readonly token: string
  networkChainId(): Promise<number>
  tokenBalance(): Promise<BigNumber>
  nativeBalance(): Promise<BigNumber>
  baseFee(): Promise<BigNumber | null>
  nonce(tag: "latest" | "pending"): Promise<number>
  signTransfer(recipient: string, amount: BigNumber, nonce: number, fees: Fees): Promise<{ hash: string; raw: string }>
  broadcast(raw: string): Promise<BroadcastResult>
  receipt(hash: string): Promise<Receipt | null>
  // Null when the node does not serve that block (pruned, or lagging behind).
  blockTimestamp(blockNumber: number): Promise<number | null>
  // Token transfers from the wallet in blocks at or after `sinceUnix`.
  outgoingTransfers(sinceUnix: number): Promise<OnchainTransfer[]>
}

const erc20 = new utils.Interface(ERC20Abi)

export const sendChainId = (): number => {
  const chainId = Number(conf.TX_NETWORK_ID)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid TX_NETWORK_ID="${conf.TX_NETWORK_ID}": expected a chain id such as 100 (Gnosis)`)
  }
  return chainId
}

export const sendTokenAddress = (): string => {
  try {
    return utils.getAddress(String(conf.PNK || "").trim())
  } catch {
    throw new Error(`PNK="${conf.PNK}" is not a token address`)
  }
}

export const sendRpcUrl = (chainId: number): string => {
  const override = String(process.env.TX_RPC_URL || "").trim()
  if (override) return override
  const chain = chains.find((c) => Number(c.id) === chainId)
  if (!chain) throw new Error(`No RPC URL known for TX_NETWORK_ID=${chainId}: set TX_RPC_URL`)
  return chain.rpc
}

export const explorerTxUrl = (chainId: number, hash: string): string | null => {
  const chain = chains.find((c) => Number(c.id) === chainId)
  return chain ? `https://${chain.explorer}/tx/${hash}` : null
}

// The text of a JSON-RPC error as ethers reports it (message, nested error, body).
const rpcErrorText = (err: unknown): string => {
  const e = err as { message?: string; error?: { message?: string }; body?: string }
  return [e && e.message, e && e.error && e.error.message, e && e.body].filter(Boolean).join(" | ")
}

// The node's answer, in the words of geth, Erigon, Nethermind, Besu and Reth.
export const classifyBroadcastError = (err: unknown): BroadcastResult | null => {
  const text = rpcErrorText(err).toLowerCase()
  if (/already known|known transaction|alreadyknown|already imported|already in the pool/.test(text)) return "known"
  if (/nonce too low|nonce is too low|oldnonce|noncetoolow|nonce has already been used/.test(text)) return "nonce-too-low"
  if (/replacement transaction underpriced|replacement.{0,20}not allowed|replacementnotallowed|replacement fee too low/.test(text)) {
    return "replacement-underpriced"
  }
  if (/underpriced|fee too low|feetoolow|less than (the )?block base fee|below (the )?(minimum|base fee)|gas price too low/.test(text)) {
    return "underpriced"
  }
  return null
}

const toNumber = (hex: string): number => BigNumber.from(hex).toNumber()

// The wallet of WALLET_PRIVATE_KEY, or, with `readOnlyFrom`, any address
// without a key: every check works, signing does not (`--dry-run --from`).
export const createSendChain = (opts: { readOnlyFrom?: string } = {}): SendChain => {
  const chainId = sendChainId()
  let wallet: ethers.Wallet | null = null
  let from: string
  if (opts.readOnlyFrom) {
    if (!utils.isAddress(opts.readOnlyFrom)) throw new Error(`--from "${opts.readOnlyFrom}" is not an address`)
    from = utils.getAddress(opts.readOnlyFrom)
  } else {
    const key = String(conf.WALLET_PRIVATE_KEY || "").trim()
    if (!key) throw new Error("WALLET_PRIVATE_KEY is not set: send needs the wallet that pays the rewards")
    try {
      wallet = new ethers.Wallet(key)
    } catch {
      throw new Error("WALLET_PRIVATE_KEY is not a valid private key") // never echo the key
    }
    from = wallet.address
  }
  const token = sendTokenAddress()
  const provider = new ethers.providers.StaticJsonRpcProvider({ url: sendRpcUrl(chainId), timeout: 60000 }, chainId)
  const rpc = (method: string, params: unknown[]) => provider.send(method, params)
  const getBlock = (tag: string) => rpc("eth_getBlockByNumber", [tag, false])
  const transferTopic = erc20.getEventTopic("Transfer")
  const fromTopic = utils.hexZeroPad(from, 32).toLowerCase()

  // A block's timestamp, or null for a block the node does not serve: history
  // it no longer keeps (expiry, pruning), or a block a lagging node lacks.
  const timestampOf = async (n: number): Promise<number | null> => {
    const block = await getBlock(utils.hexValue(n))
    return block && block.timestamp !== undefined && block.timestamp !== null ? toNumber(block.timestamp) : null
  }
  const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10)

  // The first block whose timestamp is >= `unix` (the latest + 1 when there is
  // none): back from the latest block in doubling steps, then a binary search.
  // It must be exact: from too late a block the logs would miss transfers, from
  // too early a block they would count older ones as this payout's. So a block
  // the node lacks stops the search, unless it is below the oldest block the
  // node serves (history expiry, pruning), which must predate `unix`.
  const firstBlockAtOrAfter = async (unix: number): Promise<number> => {
    const head = await getBlock("latest")
    if (!head || head.number === undefined || head.number === null || head.timestamp === undefined || head.timestamp === null) {
      throw new Error("the RPC returned no latest block")
    }
    let hi = toNumber(head.number) // its timestamp is >= unix
    if (toNumber(head.timestamp) < unix) return hi + 1
    let lo = -1 // older than unix, or before genesis
    for (let step = 1024; hi > 0; step *= 2) {
      const candidate = Math.max(0, hi - step)
      const at = await timestampOf(candidate)
      if (at === null) {
        lo = await oldestServedBefore(unix, candidate, hi)
        break
      }
      if (at < unix) {
        lo = candidate
        break
      }
      hi = candidate
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const at = await timestampOf(mid)
      if (at === null) throw new Error(`the node did not return block ${mid}, needed to find where the history to check starts`)
      if (at < unix) lo = mid
      else hi = mid
    }
    return hi
  }

  // The node serves no block `missing`, but serves `served`: the oldest block
  // it serves must predate `unix`, or the transfers since then cannot all be
  // read from this node (it no longer keeps the blocks between).
  const oldestServedBefore = async (unix: number, missing: number, served: number): Promise<number> => {
    let lo = missing
    let hi = served
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if ((await timestampOf(mid)) === null) lo = mid
      else hi = mid
    }
    const at = await timestampOf(hi)
    if (at === null || at >= unix) {
      throw new Error(
        `the node no longer serves the blocks back to ${day(unix)} (the oldest it serves, ${hi}, is of ` +
          `${at === null ? "an unknown date" : day(at)}): use an RPC that keeps that history`
      )
    }
    return hi
  }

  // eth_getLogs over [from, to], in smaller ranges when a node refuses a wide one.
  const getLogs = async (filter: { address: string; topics: (string | null)[] }, fromBlock: number, toBlock: number) => {
    const out: { topics: string[]; data: string; transactionHash: string; blockNumber: string; removed?: boolean }[] = []
    let span = toBlock - fromBlock + 1
    for (let start = fromBlock; start <= toBlock; ) {
      const end = Math.min(toBlock, start + span - 1)
      try {
        out.push(...(await rpc("eth_getLogs", [{ ...filter, fromBlock: utils.hexValue(start), toBlock: utils.hexValue(end) }])))
        start = end + 1
      } catch (err) {
        if (span <= 1000) throw new Error(`eth_getLogs failed for blocks ${start}..${end}: ${errorMessage(err)}`)
        span = Math.max(1000, Math.floor(span / 4))
      }
    }
    return out
  }

  return {
    chainId,
    from,
    token,
    networkChainId: async () => toNumber(await rpc("eth_chainId", [])),
    tokenBalance: async () => {
      const data = erc20.encodeFunctionData("balanceOf", [from])
      const out = await rpc("eth_call", [{ to: token, data }, "latest"])
      return erc20.decodeFunctionResult("balanceOf", out)[0] as BigNumber
    },
    nativeBalance: async () => BigNumber.from(await rpc("eth_getBalance", [from, "latest"])),
    baseFee: async () => {
      const block = await getBlock("latest")
      return block && block.baseFeePerGas ? BigNumber.from(block.baseFeePerGas) : null
    },
    nonce: async (tag) => toNumber(await rpc("eth_getTransactionCount", [from, tag])),
    signTransfer: async (recipient, amount, nonce, fees) => {
      if (!wallet) throw new Error(`read-only: no key for ${from}`)
      const raw = await wallet.signTransaction({
        type: 2,
        chainId,
        nonce,
        to: token,
        value: 0,
        data: erc20.encodeFunctionData("transfer", [recipient, amount]),
        gasLimit: fees.gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      return { raw, hash: utils.keccak256(raw) }
    },
    broadcast: async (raw) => {
      try {
        await rpc("eth_sendRawTransaction", [raw])
        return "accepted"
      } catch (err) {
        const known = classifyBroadcastError(err)
        if (known) return known
        throw err
      }
    },
    receipt: async (hash) => {
      const r = await rpc("eth_getTransactionReceipt", [hash])
      if (!r || r.blockNumber === null || r.blockNumber === undefined) return null
      if (r.status !== undefined && r.status !== null) return { status: toNumber(r.status), blockNumber: toNumber(r.blockNumber) }
      // No status (a node that leaves it out): the token's Transfer event from
      // the wallet is what a successful transfer leaves behind.
      const logs: { address?: string; topics?: string[] }[] = Array.isArray(r.logs) ? r.logs : []
      const paid = logs.some(
        (log) =>
          String(log.address || "").toLowerCase() === token.toLowerCase() &&
          !!log.topics &&
          String(log.topics[0]).toLowerCase() === transferTopic &&
          String(log.topics[1]).toLowerCase() === fromTopic
      )
      return { status: paid ? 1 : 0, blockNumber: toNumber(r.blockNumber) }
    },
    blockTimestamp: (blockNumber) => timestampOf(blockNumber),
    outgoingTransfers: async (sinceUnix) => {
      const latest = toNumber(await rpc("eth_blockNumber", []))
      const firstBlock = await firstBlockAtOrAfter(sinceUnix)
      if (firstBlock > latest) return []
      const logs = await getLogs({ address: token, topics: [transferTopic, fromTopic] }, firstBlock, latest)
      return logs
        .filter((log) => !log.removed && log.topics.length >= 3)
        .map((log) => ({
          to: utils.getAddress(utils.hexDataSlice(log.topics[2], 12)),
          amount: BigNumber.from(log.data).toString(),
          txHash: log.transactionHash,
          blockNumber: toNumber(log.blockNumber),
        }))
    },
  }
}
