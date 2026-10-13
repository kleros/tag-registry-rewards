import * as http from "http"
import { AddressInfo } from "net"

// One simulated Solana chain behind several RPC URLs
// (http://127.0.0.1:<port>/<index>), each with faults modelling the ways a
// real provider can be wrong, plus a Jupiter tokens endpoint (/jupiter).
// Ported from the harnesses that validated the Solana counting in PR #27.

export interface Sig {
  signature: string
  slot: number
  err: null | { code: number }
}

export interface Fault {
  // getSignaturesForAddress entries older than this slot are dropped (Agave
  // whose long-term storage lookup fails): pages stop short or come back empty.
  floor?: { [address: string]: number }
  // the newest page (no `before`) is [] for these addresses
  emptyNewest?: Set<string>
  // HTTP 400 on getSignaturesForAddress for an address after this many calls
  failAfter?: { [address: string]: number }
  // HTTP 400 on getSignaturesForAddress for an address while this returns true
  failWhen?: { [address: string]: () => boolean }
  // answer getSignaturesForAddress for an address this many ms late
  delay?: { [address: string]: number }
  // HTTP 403 for these methods
  forbid?: Set<string>
  // getBlock answers -32009 (missing in long-term storage) in [from, to)
  missingBlocks?: [number, number]
  // getSignaturesForAddress pages for an address cut to this many entries
  // (a provider answering short while older history exists)
  truncate?: { [address: string]: number }
  // HTTP 429 for every call
  rateLimitAll?: boolean
  // HTTP status for every call (401, 402, 403, 500…)
  status?: number
  // getProgramAccounts without an owner bucket filter is too large (HTTP 413)
  programAccountsTooLarge?: boolean
  // getProgramAccounts rejects the "tokenAccountState" filter (-32602)
  rejectTokenAccountState?: boolean
}

// An SPL token account: its mint and its owner (32 bytes).
export interface TokenAccount {
  mint: string
  owner: Buffer
}

export class MockChain {
  tip: number
  skipped = new Set<number>()
  histories: { [address: string]: Sig[] } = {} // newest first
  faults: Fault[]
  calls: { [key: string]: number } = {}
  getSlots = 0
  onGetSlot?: (n: number) => void // called after answering the n-th getSlot
  // holders: account owners (by program id), token accounts and Jupiter's view
  accounts: { [address: string]: { owner: string; executable?: boolean } } = {}
  tokenAccounts: TokenAccount[] = []
  jupiter: { [mint: string]: { holderCount?: number; createdAt?: string; tokenProgram?: string } } = {}
  jupiterStatus = 200
  private server!: http.Server
  port = 0

  constructor(tip: number, urls: number) {
    this.tip = tip
    this.faults = Array.from({ length: urls }, () => ({}))
  }

  // Appends signatures at these slots (all at or after the current newest one).
  // Every third signature is a failed transaction.
  addHistory(address: string, slots: number[]): void {
    const existing = this.histories[address] || [] // newest first
    const added: Sig[] = slots
      .slice()
      .sort((a, b) => a - b)
      .map((slot, i) => {
        const n = existing.length + i
        return { signature: `${address.slice(0, 6)}-${n}`, slot, err: n % 3 === 0 ? { code: 1 } : null }
      })
    this.histories[address] = added.reverse().concat(existing)
  }

  // The true counts: signatures with atOrAbove <= slot < belowSlot, and the successful ones.
  ok(address: string, belowSlot = Infinity, atOrAbove = -Infinity): { total: number; ok: number } {
    const sigs = (this.histories[address] || []).filter((s) => s.slot < belowSlot && s.slot >= atOrAbove)
    return { total: sigs.length, ok: sigs.filter((s) => s.err === null).length }
  }

  urls(): string[] {
    return this.faults.map((_, i) => `http://127.0.0.1:${this.port}/${i}`)
  }

  get jupiterUrl(): string {
    return `http://127.0.0.1:${this.port}/jupiter`
  }

  count(key: string): void {
    this.calls[key] = (this.calls[key] || 0) + 1
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" })
          res.end(JSON.stringify(payload))
        }
        if ((req.url || "").startsWith("/jupiter")) {
          this.count("jupiter")
          if (this.jupiterStatus !== 200) return reply(this.jupiterStatus, { error: "down" })
          const query = new URL(req.url || "", "http://x").searchParams.get("query") || ""
          const out = query
            .split(",")
            .filter((mint) => this.jupiter[mint])
            .map((mint) => ({ id: mint, ...this.jupiter[mint] }))
          return reply(200, out)
        }
        const url = Number((req.url || "/0").slice(1))
        const { id, method, params } = JSON.parse(body)
        this.count(`${method}@${url}`)
        this.count(method)
        const fault = this.faults[url] || {}
        if (fault.status) return reply(fault.status, { error: `status ${fault.status}` })
        if (fault.forbid && fault.forbid.has(method)) return reply(403, { error: "forbidden" })
        if (fault.rateLimitAll) return reply(429, { error: "rate limited" })
        const answer = () => {
          try {
            const result = this.handle(url, fault, method, params)
            reply(200, { jsonrpc: "2.0", id, result })
          } catch (err) {
            const e = err as { http?: number; code?: number; message: string }
            if (e.http) return reply(e.http, { error: e.message })
            reply(200, { jsonrpc: "2.0", id, error: { code: e.code, message: e.message } })
          }
        }
        const late = method === "getSignaturesForAddress" && fault.delay ? fault.delay[params[0]] : 0
        if (late) setTimeout(answer, late)
        else answer()
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()))
    this.server.unref()
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const closeAll = (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections
      if (closeAll) closeAll.call(this.server)
      this.server.close(() => resolve())
    })
  }

  private handle(url: number, fault: Fault, method: string, params: any[]): unknown {
    if (method === "getSlot") {
      const tip = this.tip
      if (this.onGetSlot) this.onGetSlot(++this.getSlots)
      return tip
    }
    if (method === "getBlock") {
      const slot = params[0]
      if (slot > this.tip) throw { code: -32004, message: `Block not available for slot ${slot}` }
      if (fault.missingBlocks && slot >= fault.missingBlocks[0] && slot < fault.missingBlocks[1]) {
        throw { code: -32009, message: `Slot ${slot} was skipped, or missing in long-term storage` }
      }
      if (this.skipped.has(slot)) throw { code: -32007, message: `Slot ${slot} was skipped` }
      return { signatures: [`x-${slot}`, `anc-${slot}`] }
    }
    if (method === "getSignatureStatuses") {
      const sig: string = params[0][0]
      const known = sig.startsWith("anc-") || Object.values(this.histories).some((h) => h.some((s) => s.signature === sig))
      return { value: [known ? { slot: 1, confirmations: null, err: null } : null] }
    }
    if (method === "getSignaturesForAddress") {
      const [address, config] = params
      this.count(`gsfa:${address}`)
      if (fault.failAfter && fault.failAfter[address] !== undefined) {
        if (this.calls[`gsfa:${address}`] > fault.failAfter[address]) throw { http: 400, message: "injected failure" }
      }
      if (fault.failWhen && fault.failWhen[address] && fault.failWhen[address]()) {
        throw { http: 400, message: "injected failure" }
      }
      const list = this.histories[address] || []
      let start = 0
      if (config.before) {
        if (config.before.startsWith("anc-")) {
          const s = Number(config.before.slice(4))
          start = list.findIndex((x) => x.slot <= s)
          if (start < 0) start = list.length
        } else {
          const i = list.findIndex((x) => x.signature === config.before)
          if (i < 0) throw { code: -32020, message: "before signature not found" }
          start = i + 1
        }
      } else if (fault.emptyNewest && fault.emptyNewest.has(address)) {
        return []
      }
      let end = list.length
      if (config.until) {
        if (config.until.startsWith("anc-")) {
          const s = Number(config.until.slice(4))
          const i = list.findIndex((x) => x.slot <= s)
          end = i < 0 ? list.length : i
        } else {
          const i = list.findIndex((x) => x.signature === config.until)
          if (i >= 0) end = i
        }
      }
      let page = list.slice(start, Math.min(end, start + config.limit))
      const floor = fault.floor && fault.floor[address]
      if (floor !== undefined) {
        const cut = page.findIndex((x) => x.slot < floor)
        if (cut >= 0) page = page.slice(0, cut)
      }
      const cut = fault.truncate && fault.truncate[address]
      if (cut !== undefined) page = page.slice(0, cut)
      return page.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err, blockTime: s.slot }))
    }
    if (method === "getMultipleAccounts") {
      const keys: string[] = params[0]
      return { context: { slot: this.tip }, value: keys.map((k) => (this.accounts[k] ? { owner: this.accounts[k].owner, executable: !!this.accounts[k].executable, data: ["", "base64"], lamports: 1 } : null)) }
    }
    if (method === "getProgramAccounts") {
      const [, config] = params
      const filters: any[] = config.filters || []
      const mintFilter = filters.find((f) => f && f.memcmp && f.memcmp.offset === 0)
      const bucket = filters.find((f) => f && f.memcmp && f.memcmp.offset === 63)
      if (!mintFilter) throw { code: -32602, message: "missing mint filter" }
      if (fault.rejectTokenAccountState && filters.includes("tokenAccountState")) {
        throw { code: -32602, message: "Invalid param: unknown filter tokenAccountState" }
      }
      if (fault.programAccountsTooLarge && !bucket) throw { http: 413, message: "response too large" }
      const byte = bucket ? Buffer.from(bucket.memcmp.bytes, "base64")[0] : undefined
      return this.tokenAccounts
        .filter((a) => a.mint === mintFilter.memcmp.bytes)
        .filter((a) => byte === undefined || a.owner[31] === byte)
        .map((a) => ({ pubkey: "acct", account: { data: [a.owner.toString("base64"), "base64"] } }))
    }
    throw { code: -32601, message: `method ${method} not mocked` }
  }
}

// Deterministic slots for a history: `n` signatures in [from, to), denser near
// `from` when `burst` > 0 (a launch burst, like most pump.fun mints).
export const slotsFor = (n: number, from: number, to: number, burst = 0, seed = 1): number[] => {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const u = rand()
    const x = burst > 0 ? Math.pow(u, 1 + burst) : u
    out.push(Math.floor(from + x * (to - from)))
  }
  return out
}

// A chain like the scenarios use: tip 2,000,000 with ~3% skipped slots.
export const newChain = async (urls = 2, tip = 2000000): Promise<MockChain> => {
  const chain = new MockChain(tip, urls)
  for (const s of slotsFor(60000, 1, tip - 1000, 0, 99)) chain.skipped.add(s)
  return chain.start()
}
