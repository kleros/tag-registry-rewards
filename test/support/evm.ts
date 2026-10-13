import { BigNumber, utils } from "ethers"
import { MockServer, startMockServer } from "./http"

// A small EVM JSON-RPC node: blocks, a PNK-like ERC-20, nonces and a mempool,
// raw transactions decoded and checked like a real node, receipts and
// Transfer logs, plus the faults `send` must survive.

const erc20 = new utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function supportsInterface(bytes4 id) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
])
const TRANSFER_TOPIC = erc20.getEventTopic("Transfer")
const hex = (n: number | bigint | BigNumber): string => BigNumber.from(n).toHexString().replace(/^0x0+(?=.)/, "0x")

interface Block {
  number: number
  timestamp: number
  baseFeePerGas: bigint
}

interface Log {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  transactionHash: string
  logIndex: number
}

interface PendingTx {
  hash: string
  from: string
  nonce: number
  to: string
  data: string
  maxFeePerGas: BigNumber
  maxPriorityFeePerGas?: BigNumber
  gasLimit?: BigNumber
  type?: number | null
  chainId?: number
}

export interface MinedTx extends PendingTx {
  blockNumber: number
  status: 0 | 1
}

export interface EvmFaults {
  // HTTP 500 for the next N calls of a method.
  failNext?: { [method: string]: number }
  // The next N eth_sendRawTransaction calls: the node takes the transaction,
  // but the answer is lost (HTTP 500).
  broadcastLost?: number
  // The next N eth_sendRawTransaction calls fail without taking it.
  broadcastDropped?: number
  // eth_getLogs refuses ranges wider than this many blocks.
  getLogsMaxBlocks?: number
  // Receipts of mined transactions answer null this many times first.
  receiptLag?: number
  // Token transfers to these addresses (lowercase) revert.
  revertTo?: Set<string>
  // The node no longer serves blocks below this number (history expiry).
  prunedBelow?: number
  // Receipts come without their status field.
  receiptsWithoutStatus?: boolean
  // Receipts come without their logs (with receiptsWithoutStatus, nothing in
  // them tells a success from a revert).
  receiptsWithoutLogs?: boolean
  // eth_sendRawTransaction refuses in Erigon's words: "existing txn with same
  // hash" for a transaction the pool holds, "could not replace existing tx"
  // for a same-nonce one that does not raise both fees enough.
  erigon?: boolean
  // eth_getBlockByNumber answers null for these blocks (a lagging node).
  blocksWithoutData?: Set<number>
}

export class MockEvm {
  readonly chainId: number
  readonly token: string
  blocks: Block[] = []
  tokenBalances = new Map<string, bigint>()
  nativeBalances = new Map<string, bigint>()
  nonces = new Map<string, number>()
  mempool: PendingTx[] = []
  mined = new Map<string, MinedTx>()
  logs: Log[] = []
  code = new Map<string, string>()
  interfaces = new Map<string, boolean>()
  autoMine = true
  baseFee = BigInt(7) // wei
  faults: EvmFaults = {}
  calls: { [method: string]: number } = {}
  private receiptLagLeft = new Map<string, number>()
  private server!: MockServer

  constructor(opts: { chainId?: number; token?: string; startTime?: number; startBlocks?: number } = {}) {
    this.chainId = opts.chainId || 100
    this.token = utils.getAddress(opts.token || "0xcb3231aBA3b451343e0Fddfc45883c842f223846")
    const start = opts.startTime || Math.floor(Date.now() / 1000) - 100 * 86400
    for (let i = 0; i < (opts.startBlocks || 10); i++) this.blocks.push({ number: i, timestamp: start + i * 5, baseFeePerGas: this.baseFee })
    this.code.set(this.token.toLowerCase(), "0x6080")
  }

  get url(): string {
    return this.server.url
  }

  get latest(): Block {
    return this.blocks[this.blocks.length - 1]
  }

  async start(): Promise<this> {
    this.server = await startMockServer((req) => {
      const { id, method, params } = req.json || {}
      this.calls[method] = (this.calls[method] || 0) + 1
      const fail = this.faults.failNext
      if (fail && fail[method] > 0) {
        fail[method]--
        return { status: 500, raw: "internal error" }
      }
      try {
        const result = this.handle(method, params || [])
        if (result && typeof result === "object" && "httpError" in result) return { status: 500, raw: "lost" }
        return { body: { jsonrpc: "2.0", id, result } }
      } catch (err) {
        const e = err as { code?: number; message: string }
        return { body: { jsonrpc: "2.0", id, error: { code: e.code || -32000, message: e.message } } }
      }
    })
    return this
  }

  stop(): Promise<void> {
    return this.server.close()
  }

  setTokenBalance(address: string, wei: BigNumber | string): void {
    this.tokenBalances.set(address.toLowerCase(), BigInt(BigNumber.from(wei).toString()))
  }

  setNativeBalance(address: string, wei: BigNumber | string): void {
    this.nativeBalances.set(address.toLowerCase(), BigInt(BigNumber.from(wei).toString()))
  }

  tokenBalance(address: string): bigint {
    return this.tokenBalances.get(address.toLowerCase()) || BigInt(0)
  }

  // New empty blocks, `seconds` apart.
  advance(blocks: number, seconds = 5): void {
    for (let i = 0; i < blocks; i++) this.newBlock(seconds)
  }

  // A token transfer from `from` mined `secondsAgo` before the latest block
  // (history the wallet made before the tests' ledger existed).
  addPastTransfer(from: string, to: string, amount: BigNumber | string, at?: number): string {
    const block = this.newBlock(5, at)
    const hash = utils.id(`past:${from}:${to}:${amount.toString()}:${block.number}`)
    this.mined.set(hash, {
      hash,
      from: from.toLowerCase(),
      nonce: -1,
      to: this.token,
      data: "0x",
      maxFeePerGas: BigNumber.from(0),
      blockNumber: block.number,
      status: 1,
    })
    this.pushTransferLog(from, to, BigNumber.from(amount), block.number, hash)
    return hash
  }

  // Mines every pending transaction that can be mined, in nonce order, into one block.
  mine(): MinedTx[] {
    const block = this.newBlock(5)
    const out: MinedTx[] = []
    for (let progress = true; progress; ) {
      progress = false
      for (const tx of this.mempool.slice()) {
        if (tx.nonce !== (this.nonces.get(tx.from) || 0)) continue
        this.mempool.splice(this.mempool.indexOf(tx), 1)
        out.push(this.execute(tx, block.number))
        progress = true
      }
    }
    return out
  }

  // Drops the mempool (a node restart, or a transaction evicted).
  dropMempool(): void {
    this.mempool = []
  }

  transfersFrom(address: string): { to: string; amount: string; hash: string; status: number }[] {
    return Array.from(this.mined.values())
      .filter((tx) => tx.from === address.toLowerCase() && tx.nonce >= 0 && tx.to.toLowerCase() === this.token.toLowerCase())
      .map((tx) => {
        const [to, amount] = erc20.decodeFunctionData("transfer", tx.data)
        return { to: utils.getAddress(to), amount: amount.toString(), hash: tx.hash, status: tx.status }
      })
  }

  private newBlock(seconds: number, at?: number): Block {
    const block = { number: this.blocks.length, timestamp: at || this.latest.timestamp + seconds, baseFeePerGas: this.baseFee }
    this.blocks.push(block)
    return block
  }

  private pushTransferLog(from: string, to: string, amount: BigNumber, blockNumber: number, hash: string): void {
    this.logs.push({
      address: this.token,
      topics: [TRANSFER_TOPIC, utils.hexZeroPad(from, 32).toLowerCase(), utils.hexZeroPad(to, 32).toLowerCase()],
      data: utils.hexZeroPad(amount.toHexString(), 32),
      blockNumber,
      transactionHash: hash,
      logIndex: this.logs.length,
    })
  }

  private execute(tx: PendingTx, blockNumber: number): MinedTx {
    this.nonces.set(tx.from, tx.nonce + 1)
    let status: 0 | 1 = 1
    if (tx.to.toLowerCase() === this.token.toLowerCase()) {
      const [to, amount] = erc20.decodeFunctionData("transfer", tx.data)
      const value = BigInt(amount.toString())
      const balance = this.tokenBalance(tx.from)
      const blocked = this.faults.revertTo && this.faults.revertTo.has(String(to).toLowerCase())
      if (balance < value || blocked) status = 0
      else {
        this.tokenBalances.set(tx.from, balance - value)
        this.tokenBalances.set(String(to).toLowerCase(), this.tokenBalance(to) + value)
        this.pushTransferLog(tx.from, to, amount, blockNumber, tx.hash)
      }
    }
    const mined = { ...tx, blockNumber, status }
    this.mined.set(tx.hash, mined)
    if (this.faults.receiptLag) this.receiptLagLeft.set(tx.hash, this.faults.receiptLag)
    return mined
  }

  private blockByTag(tag: string): Block | null {
    if (tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return this.latest
    const block = tag === "earliest" ? this.blocks[0] : this.blocks[Number(tag)] || null
    if (block && this.faults.prunedBelow !== undefined && block.number < this.faults.prunedBelow) return null
    if (block && this.faults.blocksWithoutData && this.faults.blocksWithoutData.has(block.number)) return null
    return block
  }

  private handle(method: string, params: any[]): unknown {
    switch (method) {
      case "eth_chainId":
        return hex(this.chainId)
      case "net_version":
        return String(this.chainId)
      case "eth_blockNumber":
        return hex(this.latest.number)
      case "eth_getBlockByNumber": {
        const block = this.blockByTag(params[0])
        if (!block) return null
        return {
          number: hex(block.number),
          timestamp: hex(block.timestamp),
          baseFeePerGas: hex(block.baseFeePerGas),
          hash: utils.id(`block:${block.number}`),
          parentHash: utils.id(`block:${block.number - 1}`),
          gasLimit: hex(30000000),
          gasUsed: "0x0",
          transactions: [],
        }
      }
      case "eth_getBalance":
        return hex(this.nativeBalances.get(String(params[0]).toLowerCase()) || BigInt(0))
      case "eth_getCode":
        return this.code.get(String(params[0]).toLowerCase()) || "0x"
      case "eth_call": {
        const { to, data } = params[0]
        const selector = String(data).slice(0, 10)
        if (String(to).toLowerCase() === this.token.toLowerCase() && selector === erc20.getSighash("balanceOf")) {
          const [owner] = erc20.decodeFunctionData("balanceOf", data)
          return erc20.encodeFunctionResult("balanceOf", [this.tokenBalance(owner).toString()])
        }
        if (selector === erc20.getSighash("supportsInterface")) {
          const answer = this.interfaces.get(String(to).toLowerCase())
          if (answer === undefined) throw { code: 3, message: "execution reverted" }
          return erc20.encodeFunctionResult("supportsInterface", [answer])
        }
        throw { code: 3, message: "execution reverted" }
      }
      case "eth_getTransactionCount": {
        const address = String(params[0]).toLowerCase()
        let nonce = this.nonces.get(address) || 0
        if (params[1] === "pending") {
          while (this.mempool.some((tx) => tx.from === address && tx.nonce === nonce)) nonce++
        }
        return hex(nonce)
      }
      case "eth_sendRawTransaction":
        return this.sendRaw(params[0])
      case "eth_getTransactionReceipt": {
        const tx = this.mined.get(String(params[0]).toLowerCase()) || this.mined.get(String(params[0]))
        if (!tx) return null
        const lag = this.receiptLagLeft.get(tx.hash) || 0
        if (lag > 0) {
          this.receiptLagLeft.set(tx.hash, lag - 1)
          return null
        }
        return {
          transactionHash: tx.hash,
          blockNumber: hex(tx.blockNumber),
          ...(this.faults.receiptsWithoutStatus ? {} : { status: hex(tx.status) }),
          gasUsed: hex(52000),
          ...(this.faults.receiptsWithoutLogs
            ? {}
            : { logs: this.logs.filter((l) => l.transactionHash === tx.hash).map((l) => this.formatLog(l)) }),
        }
      }
      case "eth_getTransactionByHash": {
        const hash = String(params[0])
        const tx = this.mined.get(hash) || this.mempool.find((p) => p.hash === hash)
        if (!tx) return null
        return { hash: tx.hash, from: tx.from, nonce: hex(tx.nonce), blockNumber: "blockNumber" in tx ? hex((tx as MinedTx).blockNumber) : null }
      }
      case "eth_getLogs": {
        const filter = params[0]
        const from = filter.fromBlock ? Number(filter.fromBlock) : 0
        const to = filter.toBlock && filter.toBlock !== "latest" ? Number(filter.toBlock) : this.latest.number
        if (this.faults.getLogsMaxBlocks && to - from + 1 > this.faults.getLogsMaxBlocks) {
          throw { code: -32005, message: `query exceeds max block range ${this.faults.getLogsMaxBlocks}` }
        }
        const topics: (string | null)[] = filter.topics || []
        return this.logs
          .filter((l) => !filter.address || l.address.toLowerCase() === String(filter.address).toLowerCase())
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
          .filter((l) => topics.every((t, i) => t === null || (l.topics[i] || "").toLowerCase() === String(t).toLowerCase()))
          .map((l) => this.formatLog(l))
      }
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return hex(1000000000)
      case "eth_estimateGas":
        return hex(60000)
      default:
        throw { code: -32601, message: `method ${method} not mocked` }
    }
  }

  private formatLog(l: Log) {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: hex(l.blockNumber),
      transactionHash: l.transactionHash,
      logIndex: hex(l.logIndex),
      removed: false,
    }
  }

  private sendRaw(raw: string): unknown {
    const tx = utils.parseTransaction(raw)
    if (!tx.from || !tx.hash) throw { code: -32000, message: "invalid signature" }
    if (tx.chainId !== this.chainId) throw { code: -32000, message: `invalid chain id ${tx.chainId}` }
    const dropped = this.faults.broadcastDropped || 0
    if (dropped > 0) {
      this.faults.broadcastDropped = dropped - 1
      return { httpError: true }
    }
    const from = tx.from.toLowerCase()
    if (this.faults.erigon && this.mempool.some((p) => p.hash === tx.hash)) {
      throw { code: -32000, message: "INTERNAL_ERROR: existing txn with same hash" }
    }
    if (this.mined.has(tx.hash) || this.mempool.some((p) => p.hash === tx.hash)) throw { code: -32000, message: "already known" }
    if (tx.nonce < (this.nonces.get(from) || 0)) throw { code: -32000, message: "nonce too low" }
    const pending: PendingTx = {
      hash: tx.hash,
      from,
      nonce: tx.nonce,
      to: tx.to || "",
      data: tx.data,
      maxFeePerGas: tx.maxFeePerGas || tx.gasPrice || BigNumber.from(0),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas || undefined,
      gasLimit: tx.gasLimit,
      type: tx.type,
      chainId: tx.chainId,
    }
    const same = this.mempool.find((p) => p.from === from && p.nonce === tx.nonce)
    if (same) {
      // geth's rule: both the fee cap and the tip rise by 10% or more
      const tip = pending.maxPriorityFeePerGas || BigNumber.from(0)
      const oldTip = same.maxPriorityFeePerGas || BigNumber.from(0)
      if (pending.maxFeePerGas.lt(same.maxFeePerGas.mul(11).div(10)) || tip.lt(oldTip.mul(11).div(10)) || tip.lte(oldTip)) {
        throw { code: -32000, message: this.faults.erigon ? "INTERNAL_ERROR: could not replace existing tx" : "replacement transaction underpriced" }
      }
      this.mempool.splice(this.mempool.indexOf(same), 1)
    }
    this.mempool.push(pending)
    if (this.autoMine) this.mine()
    const lost = this.faults.broadcastLost || 0
    if (lost > 0) {
      this.faults.broadcastLost = lost - 1
      return { httpError: true }
    }
    return tx.hash
  }
}
