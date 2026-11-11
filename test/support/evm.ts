import { BigNumber, utils } from "ethers"
import { readFileSync } from "fs"
import { join } from "path"
import { MockServer, startMockServer } from "./http"

// A small EVM JSON-RPC node: blocks, a PNK-like ERC-20, nonces and a mempool,
// raw transactions decoded and checked like a real node, receipts and
// Transfer logs, plus the faults `send` must survive.

const erc20 = new utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function supportsInterface(bytes4 id) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
])
const TRANSFER_TOPIC = erc20.getEventTopic("Transfer")
const APPROVAL_TOPIC = erc20.getEventTopic("Approval")
// Disperse (disperse.app), at its address on every chain, with its real code
// (test/fixtures/disperse/): disperseTokenSimple is executed here, as
// token.transferFrom(sender, recipient, value) for each, all or none.
export const DISPERSE = "0xd152f549545093347a162dce210e7293f1452150"
export const DISPERSE_RUNTIME = readFileSync(join(__dirname, "..", "fixtures", "disperse", "runtime.hex"), "utf8").trim()
const disperseAbi = new utils.Interface(["function disperseTokenSimple(address token, address[] recipients, uint256[] values)"])
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
const multicall3 = new utils.Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
])
// A view function of a stubbed contract: gets the calldata, returns the ABI-encoded
// result, or throws { code: 3, message: "execution reverted" } like a revert.
export type ContractStub = (data: string) => string
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
  value?: BigNumber
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
  allowances = new Map<string, bigint>() // "owner:spender", lowercase
  nativeBalances = new Map<string, bigint>()
  nonces = new Map<string, number>()
  mempool: PendingTx[] = []
  mined = new Map<string, MinedTx>()
  logs: Log[] = []
  code = new Map<string, string>()
  interfaces = new Map<string, boolean>()
  // eth_call answers of stubbed contracts, by lowercase address (prediction-market probes).
  contracts = new Map<string, ContractStub>()
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
    this.code.set(DISPERSE, DISPERSE_RUNTIME)
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

  allowance(owner: string, spender: string): bigint {
    return this.allowances.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) || BigInt(0)
  }

  setAllowance(owner: string, spender: string, wei: BigNumber | string): void {
    this.allowances.set(`${owner.toLowerCase()}:${spender.toLowerCase()}`, BigInt(BigNumber.from(wei).toString()))
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

  // The wallet's token transfers, in the order they were mined: its plain
  // transfers (reverted ones too), and each one a Disperse batch of it made.
  transfersFrom(address: string): { to: string; amount: string; hash: string; status: number }[] {
    const out: { to: string; amount: string; hash: string; status: number }[] = []
    for (const tx of this.mined.values()) {
      if (tx.from !== address.toLowerCase() || tx.nonce < 0) continue
      const target = tx.to.toLowerCase()
      if (target === this.token.toLowerCase() && tx.data.startsWith(erc20.getSighash("transfer"))) {
        const [to, amount] = erc20.decodeFunctionData("transfer", tx.data)
        out.push({ to: utils.getAddress(to), amount: amount.toString(), hash: tx.hash, status: tx.status })
      } else if (target === DISPERSE && tx.status === 1) {
        for (const log of this.logs) {
          if (log.transactionHash !== tx.hash || log.topics[0] !== TRANSFER_TOPIC) continue
          out.push({ to: utils.getAddress(`0x${log.topics[2].slice(26)}`), amount: BigNumber.from(log.data).toString(), hash: tx.hash, status: 1 })
        }
      }
    }
    return out
  }

  // disperseTokenSimple(token, recipients, values) from `from`: whether it
  // succeeds (every transferFrom covered by the balance and Disperse's
  // allowance), and, with `mined`, its transfers made.
  private disperse(from: string, data: string, mined?: { blockNumber: number; hash: string }): boolean {
    if (this.code.get(DISPERSE) !== DISPERSE_RUNTIME) return false
    const [token, recipients, values] = disperseAbi.decodeFunctionData("disperseTokenSimple", data)
    if (String(token).toLowerCase() !== this.token.toLowerCase()) return false
    let balance = this.tokenBalance(from)
    let allowance = this.allowance(from, DISPERSE)
    for (let i = 0; i < recipients.length; i++) {
      const value = BigInt(values[i].toString())
      const blocked = this.faults.revertTo && this.faults.revertTo.has(String(recipients[i]).toLowerCase())
      if (balance < value || allowance < value || blocked) return false
      balance -= value
      allowance -= value
    }
    if (!mined) return true
    for (let i = 0; i < recipients.length; i++) {
      const value = BigInt(values[i].toString())
      this.tokenBalances.set(from.toLowerCase(), this.tokenBalance(from) - value)
      this.tokenBalances.set(String(recipients[i]).toLowerCase(), this.tokenBalance(recipients[i]) + value)
      this.pushTransferLog(from, recipients[i], BigNumber.from(values[i]), mined.blockNumber, mined.hash)
    }
    this.setAllowance(from, DISPERSE, allowance.toString())
    return true
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

  // The gas a transaction uses here, near Gnosis's for PNK (whose transfers
  // call its controller: one to a fresh address takes ~84k): a transaction
  // given less runs out of gas, its nonce used, nothing done.
  gasFor(to: string, data: string): number {
    const target = String(to || "").toLowerCase()
    if (target === this.token.toLowerCase()) return String(data).startsWith(erc20.getSighash("approve")) ? 50000 : 85000
    if (target === DISPERSE && String(data).startsWith(disperseAbi.getSighash("disperseTokenSimple"))) {
      try {
        return 30000 + 65000 * disperseAbi.decodeFunctionData("disperseTokenSimple", data)[1].length
      } catch {
        return 30000
      }
    }
    return 21000
  }

  private execute(tx: PendingTx, blockNumber: number): MinedTx {
    this.nonces.set(tx.from, tx.nonce + 1)
    let status: 0 | 1 = 1
    const target = tx.to.toLowerCase()
    const outOfGas = !!tx.gasLimit && tx.gasLimit.lt(this.gasFor(tx.to, tx.data))
    const valued = !!tx.value && !BigNumber.from(tx.value).isZero()
    if (outOfGas || (valued && (target === this.token.toLowerCase() || target === DISPERSE))) {
      status = 0 // out of gas, or native value to contracts that take none
    } else if (target === this.token.toLowerCase() && tx.data.startsWith(erc20.getSighash("transfer"))) {
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
    } else if (target === this.token.toLowerCase() && tx.data.startsWith(erc20.getSighash("approve"))) {
      const [spender, amount] = erc20.decodeFunctionData("approve", tx.data)
      this.setAllowance(tx.from, spender, amount)
      this.logs.push({
        address: this.token,
        topics: [APPROVAL_TOPIC, utils.hexZeroPad(tx.from, 32).toLowerCase(), utils.hexZeroPad(spender, 32).toLowerCase()],
        data: utils.hexZeroPad(BigNumber.from(amount).toHexString(), 32),
        blockNumber,
        transactionHash: tx.hash,
        logIndex: this.logs.length,
      })
    } else if (target === this.token.toLowerCase()) {
      status = 0 // a function the token does not have
    } else if (target === DISPERSE && tx.data.startsWith(disperseAbi.getSighash("disperseTokenSimple"))) {
      if (!this.disperse(tx.from, tx.data, { blockNumber, hash: tx.hash })) status = 0
    } else if (target === DISPERSE) {
      status = 0 // Disperse has no fallback
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
        const target = String(to).toLowerCase()
        if (target === MULTICALL3 && this.code.has(MULTICALL3) && String(data).startsWith(multicall3.getSighash("aggregate3"))) {
          const [calls] = multicall3.decodeFunctionData("aggregate3", data)
          const results = calls.map((c: { target: string; allowFailure: boolean; callData: string }) => {
            try {
              return { success: true, returnData: this.stubCall(String(c.target).toLowerCase(), c.callData) }
            } catch (err) {
              if (!c.allowFailure) throw err
              return { success: false, returnData: "0x" }
            }
          })
          return multicall3.encodeFunctionResult("aggregate3", [results])
        }
        if (this.contracts.has(target)) return this.stubCall(target, data)
        const selector = String(data).slice(0, 10)
        if (String(to).toLowerCase() === this.token.toLowerCase() && selector === erc20.getSighash("balanceOf")) {
          const [owner] = erc20.decodeFunctionData("balanceOf", data)
          return erc20.encodeFunctionResult("balanceOf", [this.tokenBalance(owner).toString()])
        }
        // transfer(to, amount) simulated as `from`: true, or a revert without the balance
        if (String(to).toLowerCase() === this.token.toLowerCase() && selector === erc20.getSighash("transfer")) {
          const [recipient, amount] = erc20.decodeFunctionData("transfer", data)
          const sender = String(params[0].from || "0x0000000000000000000000000000000000000000")
          const blocked = this.faults.revertTo && this.faults.revertTo.has(String(recipient).toLowerCase())
          if (this.tokenBalance(sender) < BigInt(amount.toString()) || blocked) {
            throw { code: 3, message: "execution reverted: ERC20: transfer amount exceeds balance" }
          }
          return erc20.encodeFunctionResult("transfer", [true])
        }
        if (String(to).toLowerCase() === this.token.toLowerCase() && selector === erc20.getSighash("allowance")) {
          const [owner, spender] = erc20.decodeFunctionData("allowance", data)
          return erc20.encodeFunctionResult("allowance", [this.allowance(owner, spender).toString()])
        }
        if (String(to).toLowerCase() === this.token.toLowerCase() && selector === erc20.getSighash("approve")) {
          return erc20.encodeFunctionResult("approve", [true])
        }
        if (target === DISPERSE && selector === disperseAbi.getSighash("disperseTokenSimple")) {
          const sender = String(params[0].from || "0x0000000000000000000000000000000000000000")
          if (!this.disperse(sender, data)) throw { code: 3, message: "execution reverted" }
          return "0x"
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
        const hash = String(params[0]).toLowerCase()
        const tx = this.mined.get(hash) || this.mempool.find((p) => p.hash === hash)
        if (!tx) return null
        return {
          hash: tx.hash,
          from: tx.from,
          nonce: hex(tx.nonce),
          blockNumber: "blockNumber" in tx ? hex((tx as MinedTx).blockNumber) : null,
          to: tx.to,
          input: tx.data,
          value: hex(tx.value || 0),
          ...(tx.chainId !== undefined ? { chainId: hex(tx.chainId) } : {}),
          type: hex(tx.type || 0),
        }
      }
      case "eth_getLogs": {
        const filter = params[0]
        const from = filter.fromBlock ? Number(filter.fromBlock) : 0
        const to = filter.toBlock && filter.toBlock !== "latest" ? Number(filter.toBlock) : this.latest.number
        if (this.faults.getLogsMaxBlocks && to - from + 1 > this.faults.getLogsMaxBlocks) {
          throw { code: -32005, message: `query exceeds max block range ${this.faults.getLogsMaxBlocks}` }
        }
        // a position holds one topic, any of a list, or null for any
        const topics: (string | string[] | null)[] = filter.topics || []
        const matches = (t: string | string[] | null, topic: string) =>
          t === null || (Array.isArray(t) ? t : [t]).some((one) => String(one).toLowerCase() === topic.toLowerCase())
        return this.logs
          .filter((l) => !filter.address || l.address.toLowerCase() === String(filter.address).toLowerCase())
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
          .filter((l) => topics.every((t, i) => matches(t, l.topics[i] || "")))
          .map((l) => this.formatLog(l))
      }
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return hex(1000000000)
      case "eth_estimateGas": {
        // what the call would use, or its revert, as a node estimates
        const call = params[0] || {}
        const target = String(call.to || "").toLowerCase()
        if (target === this.token.toLowerCase() || target === DISPERSE) this.handle("eth_call", [call, "latest"])
        return hex(this.gasFor(call.to, call.data || "0x"))
      }
      default:
        throw { code: -32601, message: `method ${method} not mocked` }
    }
  }

  private stubCall(target: string, data: string): string {
    const stub = this.contracts.get(target)
    if (!stub) throw { code: 3, message: "execution reverted" }
    return stub(data)
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
      value: tx.value,
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
