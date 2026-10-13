import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { Tag } from "../../src/types"
import { SolanaRpcPool } from "../../src/utils/solana-rpc"
import { enrichSolanaTagsWithRpc, SolanaRpcAddressReport, SOLANA_RPC_DEFINITION } from "../../src/utils/solana-rpc-enrichment"
import { setEnv } from "./env"
import { freshDir } from "./files"
import { SOLANA_CHAIN } from "./fixtures"
import { MockChain } from "./solana"

// Shared by the Solana scenario tests (test/scenarios): a mock chain, a pool
// over its URLs, a cache directory per scenario and the sampler settings the
// scenarios were tuned with.

export const scenarioAddress = (c: string): string => `Mock${c}${"1".repeat(40 - 4 - c.length)}`

export const solanaTag = (address: string): Tag => ({
  id: address,
  registry: "addressTags",
  chain: SOLANA_CHAIN,
  submitter: "x",
  tagAddress: address,
  latestRequestResolutionTime: 0,
  isTokenOnAddressTags: false,
  addressTagName: "",
})

export const poolFor = (chain: MockChain, rps: number[] = []): SolanaRpcPool =>
  new SolanaRpcPool(chain.urls().map((url, i) => ({ url, rps: rps[i] || 400, inFlight: 16 })))

export const scenarioEnv = (vars: { [k: string]: string } = {}): (() => void) =>
  setEnv({
    TX_COUNT_CACHE: "on",
    SOLANA_COUNT_MODE: "auto",
    SOLANA_EXACT_BELOW: "20000",
    SOLANA_SAMPLE_POINTS: "200",
    SOLANA_SAMPLE_STRATA: "40",
    SOLANA_SAMPLE_WINDOW: "400",
    ...vars,
  })

export const freshCache = (): string => {
  const dir = freshDir("solana-cache-")
  process.env.TX_COUNT_CACHE_DIR = dir
  return dir
}

export const seedCache = (dir: string, data: object): void =>
  writeFileSync(
    join(dir, "solana-rpc.json"),
    JSON.stringify({ version: 1, definition: SOLANA_RPC_DEFINITION, entries: {}, jobs: {}, ...data })
  )

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readSolanaCache = (dir: string): any => JSON.parse(readFileSync(join(dir, "solana-rpc.json"), "utf8"))

export const countSolana = (chain: MockChain, tags: Tag[], rps?: number[]) =>
  enrichSolanaTagsWithRpc(tags, { rpc: poolFor(chain, rps), persist: true })

export const reportOf = (res: { addresses: SolanaRpcAddressReport[] }, address: string): SolanaRpcAddressReport => {
  const report = res.addresses.find((a) => a.address === address)
  if (!report) throw new Error(`no report for ${address}`)
  return report
}

export const failsWith = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
