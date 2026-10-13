import { utils } from "ethers"
import { AtqRow, Removal, Tag } from "../../src/types"

export const SOLANA_CHAIN = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

// The registry addresses of the test baseline (test/support/hermetic.js),
// which are the production ones.
export const REGISTRY = {
  addressTags: "0x66260c69d03837016d88c9877e61e08ef74c59f2",
  tokens: "0xee1502e29795ef6c2d60f8d7120596abe3bad990",
  domains: "0x957a53a994860be4750810131d9c876b2f52d6e1",
  atq: "0xae6aaed5434244be3699c56e7ebc828194f26dc3",
}

export const PNK_WEI = (pnk: number | string): string => utils.parseEther(String(pnk)).toString()

// Deterministic lowercase EVM address: evmAddress(1) = 0x00…01.
export const evmAddress = (n: number | string): string => {
  const hex = typeof n === "number" ? n.toString(16) : Buffer.from(n).toString("hex")
  return "0x" + hex.padStart(40, "0").slice(-40)
}

// A valid base58 Solana-style address, 40 characters, from a short label
// (characters outside base58 are mapped to look-alikes, so labels stay distinct).
export const solanaAddress = (label: string): string => {
  const clean = label
    .replace(/0/g, "o")
    .replace(/O/g, "Q")
    .replace(/I/g, "J")
    .replace(/l/g, "L")
    .replace(/[^1-9A-HJ-NP-Za-km-z]/g, "")
  return `Mock${clean}${"1".repeat(Math.max(0, 36 - clean.length))}`.slice(0, 44)
}

let itemCounter = 0
const nextItemId = (registry: string): string => {
  itemCounter++
  return `0x${itemCounter.toString(16).padStart(64, "0")}@${registry}`
}

export const makeTag = (overrides: Partial<Tag> = {}): Tag => {
  const registry = overrides.registry || "addressTags"
  return {
    id: overrides.id || nextItemId(REGISTRY[registry]),
    registry,
    chain: "1",
    submitter: evmAddress(0xa11ce),
    tagAddress: evmAddress(0xc0de + itemCounter),
    latestRequestResolutionTime: 1788000000,
    isTokenOnAddressTags: false,
    addressTagName: registry === "addressTags" ? "some contract" : "",
    ...overrides,
  }
}

export const makeRemoval = (overrides: Partial<Removal> = {}): Removal => ({
  id: overrides.id || nextItemId(REGISTRY.addressTags),
  itemID: overrides.itemID || `0x${(++itemCounter).toString(16).padStart(64, "0")}`,
  registry: "addressTags",
  chain: "1",
  chainName: "Ethereum Mainnet",
  submitter: evmAddress(0xbeef),
  tagAddress: evmAddress(0xdead + itemCounter),
  removedAt: 1788000000,
  ...overrides,
})

export const makeAtqRow = (overrides: Partial<AtqRow> = {}): AtqRow => ({
  itemID: overrides.itemID || `0x${(++itemCounter).toString(16).padStart(64, "0")}`,
  submissionTime: 1787990000,
  resolutionTime: 1788000000,
  requester: evmAddress(0xa7a),
  metadata: "key0 | key1",
  ...overrides,
})

// Unix seconds of a UTC date.
export const unix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)
