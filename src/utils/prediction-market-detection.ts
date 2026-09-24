import { ethers } from "ethers"
import { ChainConfig, Tag } from "../types"
import { findChainConfig } from "./chains"
import { isValidEvmAddress } from "./evm-enrichment"

// Detects prediction-market outcome/position tokens submitted to the Tokens
// registry so they are not rewarded (policy since the October 2026 period:
// a single submitter farmed ~250 Seer outcome tokens on Gnosis in Aug-Sep 2026).
//
// Detection is purely on-chain (metadata such as the Website field is
// submitter-controlled). Two kinds of probes run over every EVM token:
//
//   1. Generic: the token is a Gnosis "Wrapped1155" ERC-20 wrapper around an
//      ERC-1155 ConditionalTokens position. Any protocol built on the Gnosis
//      Conditional Tokens Framework + Wrapped1155Factory (Seer categorical /
//      scalar / futarchy / Circles markets, Omen positions, ...) is caught,
//      on every chain, without knowing its factory.
//   2. Protocol-specific: an exact match against the markets enumerated from
//      a known factory / manager (Seer, Overtime/Thales, Trueo). These give
//      an auditable "market X, outcome Y" detail and cover protocols whose
//      outcome tokens are plain ERC-20s rather than 1155 wrappers.
//
// Every RPC read goes through Multicall3 and is retried; a persistent RPC
// failure ABORTS the run instead of silently rewarding a farmed token
// (rewards are pool-based, so a missed exclusion underpays everyone else).
//
// Adding a protocol: append an entry to PREDICTION_MARKET_REGISTRIES below,
// or add a probe function and call it from detectPredictionMarketTokens.

export interface PredictionMarketMatch {
  protocol: string
  detail: string
}

// Keyed by tag id (as returned in the result map).
export type PredictionMarketMatches = { [tagId: string]: PredictionMarketMatch }

type SeerFactoryConfig = {
  kind: "seer-market-factory"
  address: string
  label: string
}

// Overtime / Thales positional & sports markets: every market deploys ERC-20
// position tokens (UP/DOWN, HOME/AWAY/DRAW, IN/OUT) that expose market(); the
// manager confirms the market with isKnownMarket().
type ThalesManagerConfig = {
  kind: "thales-market-manager"
  address: string
  label: string
}

// Trueo (ex-TrueMarkets): each TruthMarket owns its YES/NO ERC-20 tokens and
// points back to the TruthMarketManager through marketManager().
type TrueoManagerConfig = {
  kind: "trueo-market-manager"
  address: string
  label: string
}

type RegistryConfig = SeerFactoryConfig | ThalesManagerConfig | TrueoManagerConfig

// Sources (all verified by RPC on 2026-09-21):
// - Seer: github.com/seer-pm/demo contracts/README.md (deployments per chain)
// - Overtime/Thales: contracts.overtime.io
// - Trueo: github.com/truemarketsorg/true-contracts network_config.json
export const PREDICTION_MARKET_REGISTRIES: { [chainId: string]: RegistryConfig[] } = {
  "1": [
    { kind: "seer-market-factory", address: "0x1F728c2fD6a3008935c1446a965a313E657b7904", label: "Seer MarketFactory" },
  ],
  "10": [
    { kind: "seer-market-factory", address: "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6", label: "Seer MarketFactory" },
    { kind: "thales-market-manager", address: "0x9227334352A890e51e980BeB7A56Bbdd01499B54", label: "Thales PositionalMarketManager" },
    { kind: "thales-market-manager", address: "0xFBffEbfA2bF2cF84fdCf77917b358fC59Ff5771e", label: "Overtime SportPositionalMarketManager" },
  ],
  "100": [
    { kind: "seer-market-factory", address: "0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1", label: "Seer MarketFactory" },
    { kind: "seer-market-factory", address: "0x2e3937cefF8e0AC5563B5D212Bbe8f6CB8ECB68E", label: "Seer CirclesMarketFactory" },
    { kind: "seer-market-factory", address: "0xa6cb18fcdc17a2b44e5cad2d80a6d5942d30a345", label: "Seer FutarchyFactory" },
    { kind: "seer-market-factory", address: "0xe789e4A240d153AC55e32106821e785E71f6b792", label: "Seer FutarchyFactory (v1)" },
  ],
  "137": [
    { kind: "thales-market-manager", address: "0x85f1B57A1D3Ac7605de3Df8AdA056b3dB9676eCE", label: "Thales PositionalMarketManager" },
  ],
  "8453": [
    { kind: "seer-market-factory", address: "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6", label: "Seer MarketFactory" },
    { kind: "thales-market-manager", address: "0xc62E56E756a3D14ffF838e820F38d845a16D49dE", label: "Thales PositionalMarketManager" },
    { kind: "thales-market-manager", address: "0xB0EE5C967F209f24f7eF30c2C6Da38346a87E089", label: "Overtime SportPositionalMarketManager" },
    { kind: "trueo-market-manager", address: "0x61A98Bef11867c69489B91f340fE545eEfc695d7", label: "Trueo TruthMarketManager" },
  ],
  "42161": [
    { kind: "thales-market-manager", address: "0x95d93c88c1b5190fA7FA4350844e0663e5a11fF0", label: "Thales PositionalMarketManager" },
    { kind: "thales-market-manager", address: "0x72ca0765d4bE0529377d656c9645600606214610", label: "Overtime SportPositionalMarketManager" },
  ],
}

// Public RPCs tried, in order, after the chain's configured rpc fails. Public
// endpoints go down regularly (HTTP 525s, rate limits); since a failed probe
// aborts the whole run, a second opinion per chain keeps the pipeline usable.
const FALLBACK_RPCS: { [chainId: string]: string[] } = {
  "1": ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com", "https://1rpc.io/eth"],
  "10": ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  "100": ["https://gnosis-rpc.publicnode.com", "https://gnosis.drpc.org"],
  "137": ["https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
  "8453": ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
  "42161": ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  "43114": ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
  "42220": ["https://celo.drpc.org"],
  "59144": ["https://linea-rpc.publicnode.com"],
  "324": ["https://mainnet.era.zksync.io"],
  "4326": ["https://megaeth.drpc.org"],
  "4663": ["https://robinhood.drpc.org"],
}

// Multicall3 (github.com/mds1/multicall) lives at the same address on every
// rewarded EVM chain except zkSync Era, whose address derivation differs.
const MULTICALL3_DEFAULT_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"
const MULTICALL3_BY_CHAIN: { [chainId: string]: string } = {
  "324": "0xF9cda624FBC7e059355ce98a31693d299FACd963",
}
const multicallAddress = (chainCfg: ChainConfig): string =>
  MULTICALL3_BY_CHAIN[chainCfg.id] || MULTICALL3_DEFAULT_ADDRESS
const MULTICALL_CHUNK = 250
const MULTICALL_PACE_MS = 250
const RPC_MAX_ATTEMPTS = 4
// Per-request timeout: a stalled public rpc should rotate to a fallback, not hang the run.
const RPC_TIMEOUT_MS = 30000
// ethers silently retries HTTP 429s (up to 12 times with exponential backoff,
// honouring Retry-After: many minutes per request). throttleCallback=false
// surfaces the 429 immediately so withRetry rotates to another rpc.
const RPC_THROTTLE_LIMIT = 1
const noThrottle = async (): Promise<boolean> => false
const ERC1155_INTERFACE_ID = "0xd9b67a26"

const multicallInterface = new ethers.utils.Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
])
const wrapped1155Interface = new ethers.utils.Interface([
  "function multiToken() view returns (address)",
  "function tokenId() view returns (uint256)",
])
const conditionalTokensInterface = new ethers.utils.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
])
const seerFactoryInterface = new ethers.utils.Interface([
  "function allMarkets() view returns (address[])",
])
const seerMarketInterface = new ethers.utils.Interface([
  "function numOutcomes() view returns (uint256)",
  "function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)",
])
const thalesPositionInterface = new ethers.utils.Interface([
  "function market() view returns (address)",
])
const thalesManagerInterface = new ethers.utils.Interface([
  "function isKnownMarket(address candidate) view returns (bool)",
])
const trueoTokenInterface = new ethers.utils.Interface([
  "function owner() view returns (address)",
])
const trueoMarketInterface = new ethers.utils.Interface([
  "function marketManager() view returns (address)",
  "function yesToken() view returns (address)",
  "function noToken() view returns (address)",
])

type Call = { target: string; callData: string }
type CallResult = { success: boolean; returnData: string }

const providerCache: { [rpc: string]: ethers.providers.JsonRpcProvider } = {}
// Index into rpcsForChain() of the rpc that last answered, per chain: once
// the configured rpc proves dead we stop paying its timeout on every batch.
const preferredRpcIndex: { [chainId: string]: number } = {}
const rpcsForChain = (chainCfg: ChainConfig): string[] =>
  Array.from(new Set([chainCfg.rpc, ...(FALLBACK_RPCS[chainCfg.id] || [])]))

// The provider for retry `attempt` (1-based): the last known-good rpc first
// (the configured one until it fails), then the others in order, wrapping.
const providerForRpc = (chainCfg: ChainConfig, rpc: string): ethers.providers.JsonRpcProvider => {
  if (!providerCache[rpc]) {
    providerCache[rpc] = new ethers.providers.JsonRpcProvider(
      { url: rpc, timeout: RPC_TIMEOUT_MS, throttleLimit: RPC_THROTTLE_LIMIT, throttleCallback: noThrottle },
      Number(chainCfg.id)
    )
  }
  return providerCache[rpc]
}

// A fallback url filed under the wrong chain would make every probe "no match"
// on that chain; verify eth_chainId once per url and refuse a mismatch (as a
// transport error, so rotation moves on to the next rpc).
const chainIdChecks: { [rpc: string]: Promise<void> } = {}
const ensureChainId = (chainCfg: ChainConfig, provider: ethers.providers.JsonRpcProvider): Promise<void> => {
  const rpc = provider.connection.url
  if (!chainIdChecks[rpc]) {
    chainIdChecks[rpc] = (async () => {
      const reported = ethers.BigNumber.from(await provider.send("eth_chainId", [])).toString()
      if (reported !== String(Number(chainCfg.id))) {
        const error = new Error(
          `rpc ${rpc} serves chain ${reported}, not ${chainCfg.id}; check chains.ts / FALLBACK_RPCS`
        ) as Error & { code: string }
        error.code = ethers.errors.NETWORK_ERROR
        console.warn(`[pm-detect] ${error.message}`)
        throw error
      }
    })()
    chainIdChecks[rpc].catch(() => {
      delete chainIdChecks[rpc]
    })
  }
  return chainIdChecks[rpc]
}

const getProvider = (chainCfg: ChainConfig, attempt = 1): ethers.providers.JsonRpcProvider => {
  const rpcs = rpcsForChain(chainCfg)
  return providerForRpc(chainCfg, rpcs[((preferredRpcIndex[chainCfg.id] || 0) + attempt - 1) % rpcs.length])
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Error classification. ethers v5 (verified on 5.8) reports EVERY failed
// eth_call as CALL_EXCEPTION "missing revert data" and nests the cause:
//   - EVM revert without data: err.error is a SERVER_ERROR "processing response
//     error" whose .error is the raw JSON-RPC error {code: 3, message:
//     "execution reverted"}.
//   - EVM revert WITH data: the call RESOLVES with the revert bytes (see
//     revertDataToError below).
//   - HTTP 429 / 5xx: err.error is a SERVER_ERROR with a .status; timeouts are
//     TIMEOUT; unreachable rpcs surface as NETWORK_ERROR ("could not detect
//     network").
// Treating a rate-limited call as a revert would let a farmed token through
// as "no match", and treating a revert as transport wastes 4 retries, so the
// distinction is load-bearing and only message-based revert detection works.
type ErrorKind = "revert" | "transport" | "other"

const TRANSPORT_ERROR_CODES = new Set<string>([
  ethers.errors.SERVER_ERROR,
  ethers.errors.TIMEOUT,
  ethers.errors.NETWORK_ERROR,
  "EMPTY_RESULT",
])
const REVERT_MESSAGE = /revert|invalid opcode|invalid jump|stack (under|over)flow|vm execution error/i
// Gas exhaustion is rpc-dependent (each public node caps eth_call gas
// differently), so it is first retried elsewhere, like an empty result.
const GAS_CAP_MESSAGE = /out of gas|gas required exceeds|intrinsic gas|gas limit/i
// JSON-RPC error codes that only ever mean "the EVM call failed": 3 (geth /
// erigon / nethermind "execution reverted") and -32015 (nethermind "VM
// execution error."). -32000 is generic and is judged by its message.
const REVERT_RPC_CODES = new Set<number>([3, -32015])
// JSON-RPC errors that no retry or other rpc can fix: invalid request / method / params.
const DETERMINISTIC_RPC_CODES = new Set<number>([-32600, -32601, -32602])

type EthersError = {
  code?: string | number
  reason?: string
  status?: number
  message?: string
  error?: EthersError
  body?: string
}

// ethers nests causes under `.error`; collect the chain once.
const errorChain = (err: unknown): EthersError[] => {
  const chain: EthersError[] = []
  let e = err as EthersError | undefined
  for (let depth = 0; e && depth < 4; depth++) {
    chain.push(e)
    e = e.error
  }
  return chain
}

export const classifyError = (err: unknown): ErrorKind => {
  const chain = errorChain(err)
  if (chain.some((e) => e.code === "SYNTHETIC_REVERT")) return "revert"
  // The raw JSON-RPC error (numeric code) buried under ethers' wrappers, if any.
  const rpcError = chain.find((e) => typeof e.code === "number")
  if (rpcError) {
    const data = String((rpcError as { data?: unknown }).data || "")
    const message = String(rpcError.message || "")
    if (GAS_CAP_MESSAGE.test(message)) return "transport"
    if (
      REVERT_RPC_CODES.has(rpcError.code as number) ||
      REVERT_MESSAGE.test(message) ||
      /^Reverted/i.test(data)
    ) {
      return "revert"
    }
    if (DETERMINISTIC_RPC_CODES.has(rpcError.code as number)) return "other"
  }
  if (chain.some((e) => typeof e.code === "string" && TRANSPORT_ERROR_CODES.has(e.code))) return "transport"
  return "other"
}

// An eth_call that answered "0x". Either the rpc backend has no state for the
// block (unsynced / pruned node behind a load balancer) or the call reverted
// without a reason on a node that reports that as data "0x": ethers resolves
// both the same way. Classified as transport so the batch is retried on other
// rpcs; when EVERY rpc answers "0x" the caller may treat it as a revert.
const EMPTY_RESULT = "EMPTY_RESULT"
const emptyResultError = (what: string): Error => {
  const error = new Error(`empty eth_call result for ${what}`) as Error & { code: string }
  error.code = EMPTY_RESULT
  return error
}

// "Ambiguous" failures: an empty result or a gas-cap error may be one bad rpc
// node, or a genuine batch revert. withRetry rotates through the rpcs without
// backoff; if EVERY attempt was ambiguous it rethrows with code
// ALL_ATTEMPTS_AMBIGUOUS and the batch is bisected like a revert.
const ALL_ATTEMPTS_AMBIGUOUS = "ALL_ATTEMPTS_AMBIGUOUS"
const isAmbiguousRevert = (err: unknown): boolean => {
  const chain = errorChain(err)
  if (chain.some((e) => e.code === EMPTY_RESULT)) return true
  const rpcError = chain.find((e) => typeof e.code === "number")
  return !!rpcError && GAS_CAP_MESSAGE.test(String(rpcError.message || ""))
}

// Error(string) / Panic(uint256) selectors: when ethers hands these back as the
// call's result, the call actually reverted.
const REVERT_DATA_PREFIXES = ["0x08c379a0", "0x4e487b71"]
const revertDataToError = (raw: string): Error | null => {
  if (!REVERT_DATA_PREFIXES.some((p) => raw.startsWith(p))) return null
  const error = new Error("call reverted") as Error & { code: string; data: string }
  error.code = "SYNTHETIC_REVERT"
  error.data = raw
  return error
}

// Runs `fn` against the chain's rpc, rotating through the fallback rpcs on
// each failed TRANSPORT attempt with exponential backoff. Reverts and
// deterministic errors (bad ABI data, ...) are thrown straight away.
const withRetry = async <T>(
  chainCfg: ChainConfig,
  what: string,
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>
): Promise<T> => {
  let lastError: unknown
  let allAmbiguous = true
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    const provider = getProvider(chainCfg, attempt)
    try {
      await ensureChainId(chainCfg, provider)
      const result = await fn(provider)
      preferredRpcIndex[chainCfg.id] = rpcsForChain(chainCfg).indexOf(provider.connection.url)
      return result
    } catch (err) {
      lastError = err
      if (classifyError(err) !== "transport") throw err
      const ambiguous = isAmbiguousRevert(err)
      if (!ambiguous) allAmbiguous = false
      if (attempt < RPC_MAX_ATTEMPTS) {
        // An ambiguous failure is answered instantly by the node: rotate
        // without waiting, only real outages back off.
        const delay = ambiguous ? 0 : 2000 * Math.pow(2, attempt - 1)
        console.warn(
          `[pm-detect] ${what} failed via ${provider.connection.url} (attempt ${attempt}/${RPC_MAX_ATTEMPTS}), ` +
            `retrying in ${delay}ms: ${(err as Error)?.message?.slice(0, 120)}`
        )
        await sleepMs(delay)
      }
    }
  }
  const error = new Error(
    `[pm-detect] ${what} failed after ${RPC_MAX_ATTEMPTS} attempts over ${rpcsForChain(chainCfg).join(", ")}; ` +
      `aborting so no prediction-market token slips into the rewards. Last error: ${
        (lastError as Error)?.message
      }`
  ) as Error & { code?: string; error?: unknown }
  // Nest like ethers does (`.error`) so classifyError() sees the real cause.
  error.code = allAmbiguous ? ALL_ATTEMPTS_AMBIGUOUS : ((lastError as EthersError)?.code as string | undefined)
  error.error = lastError
  throw error
}

// Debug knobs: PM_DETECT_DEBUG=1 logs every batch's timing;
// PM_DETECT_DISABLE_MULTICALL=1 forces the per-call fallback path (testing).
const flag = (name: string): boolean => /^(1|true)$/i.test(String(process.env[name] || "").trim())
const DEBUG = flag("PM_DETECT_DEBUG")
const DISABLE_MULTICALL = flag("PM_DETECT_DISABLE_MULTICALL")

// eth_call that also turns Error(string)/Panic return data into a revert error.
const ethCall = async (
  provider: ethers.providers.JsonRpcProvider,
  to: string,
  data: string
): Promise<string> => {
  // Registry / tag addresses come in any letter case; ethers rejects a wrong
  // mixed-case checksum, so every target is lowercased here, once.
  const raw = await provider.call({ to: to.toLowerCase(), data })
  const revert = revertDataToError(raw)
  if (revert) throw revert
  return raw
}

// Whether Multicall3 has code on this chain (checked once per chain per run).
const multicallAvailability: { [chainId: string]: Promise<boolean> } = {}
const hasMulticall = (chainCfg: ChainConfig): Promise<boolean> => {
  if (DISABLE_MULTICALL) return Promise.resolve(false)
  if (!multicallAvailability[chainCfg.id]) {
    // A lagging backend can answer getCode with "0x"; only conclude "no
    // Multicall3" when every rpc of the chain agrees.
    multicallAvailability[chainCfg.id] = withRetry(
      chainCfg,
      `getCode(Multicall3) on chain ${chainCfg.id}`,
      async (provider) => {
        const hasCode = async (p: ethers.providers.JsonRpcProvider): Promise<boolean> => {
          const code = await p.getCode(multicallAddress(chainCfg))
          return !!code && code !== "0x"
        }
        if (await hasCode(provider)) return true
        const others = rpcsForChain(chainCfg).filter((rpc) => rpc !== provider.connection.url)
        for (const rpc of others) {
          let secondOpinion: boolean | null = null
          try {
            secondOpinion = await hasCode(providerForRpc(chainCfg, rpc))
          } catch {
            // Unreachable second opinion: inconclusive, keep asking the others.
          }
          if (secondOpinion === true) {
            throw emptyResultError(`getCode(Multicall3) via ${provider.connection.url}`)
          }
        }
        console.warn(
          `[pm-detect] no Multicall3 at ${multicallAddress(chainCfg)} on chain ${chainCfg.id} (confirmed on ${
            others.length + 1
          } rpc(s)); falling back to one eth_call per probe (slower)`
        )
        return false
      }
    )
    multicallAvailability[chainCfg.id].catch(() => {
      delete multicallAvailability[chainCfg.id]
    })
  }
  return multicallAvailability[chainCfg.id]
}

// Fallback for chains without Multicall3: one eth_call per probe, a few at a
// time, with the same allowFailure semantics (a revert is a failed result).
const INDIVIDUAL_CALL_CONCURRENCY = 5
const callIndividually = async (chainCfg: ChainConfig, calls: Call[]): Promise<CallResult[]> => {
  const results: CallResult[] = []
  for (let i = 0; i < calls.length; i += INDIVIDUAL_CALL_CONCURRENCY) {
    const group = calls.slice(i, i + INDIVIDUAL_CALL_CONCURRENCY)
    const settled = await Promise.all(
      group.map(async (c): Promise<CallResult> => {
        try {
          const raw = await withRetry(chainCfg, `eth_call ${c.target} on chain ${chainCfg.id}`, (provider) =>
            ethCall(provider, c.target, c.callData)
          )
          return { success: true, returnData: raw }
        } catch (err) {
          if (classifyError(err) === "revert") return { success: false, returnData: "0x" }
          throw err
        }
      })
    )
    results.push(...settled)
    if (i + INDIVIDUAL_CALL_CONCURRENCY < calls.length) await sleepMs(MULTICALL_PACE_MS)
  }
  return results
}

const aggregate3 = async (chainCfg: ChainConfig, chunk: Call[]): Promise<CallResult[]> => {
  const startedAt = Date.now()
  const decoded = await withRetry(
    chainCfg,
    `multicall (${chunk.length} calls) on chain ${chainCfg.id}`,
    async (provider) => {
      const data = multicallInterface.encodeFunctionData("aggregate3", [
        chunk.map((c) => ({ target: c.target.toLowerCase(), allowFailure: true, callData: c.callData })),
      ])
      const raw = await ethCall(provider, multicallAddress(chainCfg), data)
      // Multicall3 (code verified by hasMulticall) only ever answers aggregate3
      // with a well-formed array. "0x" means this rpc backend has no state for
      // the call (unsynced / pruned node behind a load balancer): a transport
      // problem, retried on another rpc. Non-empty undecodable bytes mean the
      // batch reverted on an rpc that reports reason-less reverts as data.
      if (raw === "0x") throw emptyResultError("Multicall3.aggregate3")
      try {
        return multicallInterface.decodeFunctionResult("aggregate3", raw)[0] as CallResult[]
      } catch {
        const error = new Error("aggregate3 batch reverted") as Error & { code: string; data: string }
        error.code = "SYNTHETIC_REVERT"
        error.data = raw
        throw error
      }
    }
  )
  if (decoded.length !== chunk.length) {
    throw new Error(`[pm-detect] multicall returned ${decoded.length} results for ${chunk.length} calls`)
  }
  if (DEBUG) {
    console.log(
      `[pm-detect:debug] chain ${chainCfg.id} multicall ${chunk.length} calls (selector ${chunk[0].callData.slice(0, 10)}) ` +
        `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    )
  }
  return decoded.map((r) => ({ success: r.success, returnData: r.returnData }))
}

// aggregate3 with allowFailure=true never reverts because of a failing target,
// but the WHOLE batch can still revert when one target burns the batch's gas
// (odd fallback functions, rpc gas caps). Bisect such a batch down to the
// offending call; a call that reverts even on its own is simply "no match"
// (every probe we run is a cheap view on a genuine outcome token). If that
// happens to many calls of one batch something is wrong with the rpc, not the
// tokens, and the run aborts rather than silently passing them all.
const MAX_SOLO_REVERTS_PER_BATCH = 5

const bisect = async (
  chainCfg: ChainConfig,
  chunk: Call[],
  soloReverts: Set<string>
): Promise<CallResult[]> => {
  try {
    return await aggregate3(chainCfg, chunk)
  } catch (err) {
    // The same ambiguous answer from every rpc is a batch revert (reason-less
    // revert reported as "0x", or a batch too heavy for every gas cap), not a
    // bad backend: bisect it like any other batch revert.
    const ambiguousEverywhere = (err as EthersError)?.code === ALL_ATTEMPTS_AMBIGUOUS
    if (!ambiguousEverywhere && classifyError(err) !== "revert") throw err
    if (chunk.length === 1) {
      // Several probes hit the same target, so count distinct targets.
      soloReverts.add(chunk[0].target.toLowerCase())
      if (soloReverts.size > MAX_SOLO_REVERTS_PER_BATCH) {
        throw new Error(
          `[pm-detect] more than ${MAX_SOLO_REVERTS_PER_BATCH} distinct targets of one batch revert on their own on chain ${chainCfg.id} ` +
            `(last: ${chunk[0].target}); the rpc looks broken, aborting so no prediction-market token slips into the rewards`
        )
      }
      console.warn(
        `[pm-detect] call to ${chunk[0].target} on chain ${chainCfg.id} reverts the multicall even alone; treating as no match`
      )
      return [{ success: false, returnData: "0x" }]
    }
    const mid = Math.ceil(chunk.length / 2)
    return [
      ...(await bisect(chainCfg, chunk.slice(0, mid), soloReverts)),
      ...(await bisect(chainCfg, chunk.slice(mid), soloReverts)),
    ]
  }
}

const aggregate3Bisecting = (chainCfg: ChainConfig, chunk: Call[]): Promise<CallResult[]> =>
  bisect(chainCfg, chunk, new Set<string>())

// Batched eth_call via Multicall3. Results are returned in call order. Chunks
// are paced a little so public rpcs are less likely to answer 429.
const multicall = async (chainCfg: ChainConfig, calls: Call[]): Promise<CallResult[]> => {
  if (calls.length === 0) return []
  if (!(await hasMulticall(chainCfg))) return callIndividually(chainCfg, calls)
  const results: CallResult[] = []
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    if (i > 0) await sleepMs(MULTICALL_PACE_MS)
    results.push(...(await aggregate3Bisecting(chainCfg, calls.slice(i, i + MULTICALL_CHUNK))))
  }
  return results
}

// Decode a single-word return value; null when the call failed or the return
// data isn't exactly one ABI word (fallback functions returning junk).
const decodeWord = <T>(r: CallResult, type: "address" | "bool" | "uint256"): T | null => {
  if (!r.success || r.returnData.length !== 66) return null
  try {
    return ethers.utils.defaultAbiCoder.decode([type], r.returnData)[0] as T
  } catch {
    return null
  }
}
const decodeAddress = (r: CallResult): string | null => {
  const value = decodeWord<string>(r, "address")
  return value === ethers.constants.AddressZero ? null : value
}
const decodeBool = (r: CallResult): boolean | null => decodeWord<boolean>(r, "bool")
const decodeUint = (r: CallResult): number | null => {
  const value = decodeWord<ethers.BigNumber>(r, "uint256")
  try {
    return value === null ? null : value.toNumber()
  } catch {
    return null
  }
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()


const callTarget = (tag: Tag): string => tag.tagAddress

// --- Probe 1: generic Wrapped1155 conditional-token position -----------------
//
// token.multiToken() -> ERC-1155 contract that also answers the ConditionalTokens
// getOutcomeSlotCount(bytes32) selector. A normal ERC-20 has neither.
const probeWrapped1155 = async (
  chainCfg: ChainConfig,
  tags: Tag[]
): Promise<PredictionMarketMatches> => {
  const matches: PredictionMarketMatches = {}
  const results = await multicall(
    chainCfg,
    tags.flatMap((tag) => [
      { target: callTarget(tag), callData: wrapped1155Interface.encodeFunctionData("multiToken") },
      { target: callTarget(tag), callData: wrapped1155Interface.encodeFunctionData("tokenId") },
    ])
  )
  const candidates: { tag: Tag; multiToken: string; tokenId: string }[] = []
  tags.forEach((tag, i) => {
    const multiToken = decodeAddress(results[2 * i])
    const tokenId = decodeWord<ethers.BigNumber>(results[2 * i + 1], "uint256")
    if (!multiToken || tokenId === null) return
    candidates.push({ tag, multiToken, tokenId: tokenId.toString() })
  })
  if (candidates.length === 0) return matches

  const checks = await multicall(
    chainCfg,
    candidates.flatMap((c) => [
      {
        target: c.multiToken,
        callData: conditionalTokensInterface.encodeFunctionData("supportsInterface", [ERC1155_INTERFACE_ID]),
      },
      {
        target: c.multiToken,
        callData: conditionalTokensInterface.encodeFunctionData("getOutcomeSlotCount", [ethers.constants.HashZero]),
      },
    ])
  )
  candidates.forEach((c, i) => {
    const isErc1155 = decodeBool(checks[2 * i]) === true
    const answersConditionalTokens = decodeUint(checks[2 * i + 1]) !== null
    if (isErc1155 && answersConditionalTokens) {
      matches[c.tag.id] = {
        protocol: "conditional-tokens",
        detail: `Wrapped1155 position of ConditionalTokens ${c.multiToken} (tokenId ${c.tokenId})`,
      }
    }
  })
  return matches
}

// --- Probe 2a: Seer market factories (exact enumeration) ---------------------
//
// factory.allMarkets() -> market.numOutcomes() -> market.wrappedOutcome(i) for
// i in [0, numOutcomes] (the extra index is the SER-INVALID outcome).
const enumerateSeerOutcomeTokens = async (
  chainCfg: ChainConfig,
  factory: SeerFactoryConfig
): Promise<{ [tokenLower: string]: { market: string; index: number } }> => {
  const markets = await withRetry(chainCfg, `${factory.label} allMarkets() on chain ${chainCfg.id}`, async (provider) => {
    const raw = await ethCall(provider, factory.address, seerFactoryInterface.encodeFunctionData("allMarkets"))
    if (raw === "0x") throw emptyResultError(`${factory.label}.allMarkets()`)
    return seerFactoryInterface.decodeFunctionResult("allMarkets", raw)[0] as string[]
  })
  const outcomeCounts = await multicall(
    chainCfg,
    markets.map((m) => ({ target: m, callData: seerMarketInterface.encodeFunctionData("numOutcomes") }))
  )
  const outcomeCalls: { market: string; index: number }[] = []
  markets.forEach((market, i) => {
    const n = decodeUint(outcomeCounts[i])
    if (n === null) return
    for (let index = 0; index <= n; index++) outcomeCalls.push({ market, index })
  })
  const wrapped = await multicall(
    chainCfg,
    outcomeCalls.map((c) => ({
      target: c.market,
      callData: seerMarketInterface.encodeFunctionData("wrappedOutcome", [c.index]),
    }))
  )
  const tokens: { [tokenLower: string]: { market: string; index: number } } = {}
  outcomeCalls.forEach((c, i) => {
    if (!wrapped[i].success) return
    try {
      const [address] = seerMarketInterface.decodeFunctionResult("wrappedOutcome", wrapped[i].returnData)
      if (address && address !== ethers.constants.AddressZero) {
        tokens[String(address).toLowerCase()] = c
      }
    } catch {
      /* not a Seer market */
    }
  })
  console.log(
    `[pm-detect] ${factory.label} (chain ${chainCfg.id}): ${markets.length} markets, ${
      Object.keys(tokens).length
    } outcome tokens`
  )
  return tokens
}

const probeSeer = async (
  chainCfg: ChainConfig,
  factories: SeerFactoryConfig[],
  tags: Tag[]
): Promise<PredictionMarketMatches> => {
  const matches: PredictionMarketMatches = {}
  for (const factory of factories) {
    const tokens = await enumerateSeerOutcomeTokens(chainCfg, factory)
    for (const tag of tags) {
      if (matches[tag.id]) continue
      const hit = tokens[tag.tagAddress.toLowerCase()]
      if (hit) {
        matches[tag.id] = {
          protocol: "seer",
          detail: `${factory.label} market ${hit.market} outcome #${hit.index}`,
        }
      }
    }
  }
  return matches
}

// --- Probe 2b: Overtime / Thales position tokens -----------------------------
//
// token.market() -> market; manager.isKnownMarket(market) == true.
const probeThales = async (
  chainCfg: ChainConfig,
  managers: ThalesManagerConfig[],
  tags: Tag[]
): Promise<PredictionMarketMatches> => {
  const matches: PredictionMarketMatches = {}
  const marketResults = await multicall(
    chainCfg,
    tags.map((tag) => ({ target: callTarget(tag), callData: thalesPositionInterface.encodeFunctionData("market") }))
  )
  const candidates: { tag: Tag; market: string }[] = []
  tags.forEach((tag, i) => {
    const market = decodeAddress(marketResults[i])
    if (market) candidates.push({ tag, market })
  })
  if (candidates.length === 0) return matches

  const checks = await multicall(
    chainCfg,
    candidates.flatMap((c) =>
      managers.map((m) => ({
        target: m.address,
        callData: thalesManagerInterface.encodeFunctionData("isKnownMarket", [c.market]),
      }))
    )
  )
  candidates.forEach((c, i) => {
    managers.forEach((m, j) => {
      if (matches[c.tag.id]) return
      if (decodeBool(checks[i * managers.length + j]) === true) {
        matches[c.tag.id] = { protocol: "overtime-thales", detail: `${m.label} market ${c.market}` }
      }
    })
  })
  return matches
}

// --- Probe 2c: Trueo YES/NO tokens -------------------------------------------
//
// token.owner() -> market; market.marketManager() == manager and the market
// lists the token as its yesToken() or noToken().
const probeTrueo = async (
  chainCfg: ChainConfig,
  managers: TrueoManagerConfig[],
  tags: Tag[]
): Promise<PredictionMarketMatches> => {
  const matches: PredictionMarketMatches = {}
  const ownerResults = await multicall(
    chainCfg,
    tags.map((tag) => ({ target: callTarget(tag), callData: trueoTokenInterface.encodeFunctionData("owner") }))
  )
  const candidates: { tag: Tag; market: string }[] = []
  tags.forEach((tag, i) => {
    const owner = decodeAddress(ownerResults[i])
    if (owner) candidates.push({ tag, market: owner })
  })
  if (candidates.length === 0) return matches

  const checks = await multicall(
    chainCfg,
    candidates.flatMap((c) => [
      { target: c.market, callData: trueoMarketInterface.encodeFunctionData("marketManager") },
      { target: c.market, callData: trueoMarketInterface.encodeFunctionData("yesToken") },
      { target: c.market, callData: trueoMarketInterface.encodeFunctionData("noToken") },
    ])
  )
  candidates.forEach((c, i) => {
    const manager = decodeAddress(checks[3 * i])
    const yesToken = decodeAddress(checks[3 * i + 1])
    const noToken = decodeAddress(checks[3 * i + 2])
    const knownManager = managers.find((m) => sameAddress(m.address, manager))
    if (!knownManager) return
    const side = sameAddress(yesToken, c.tag.tagAddress)
      ? "YES"
      : sameAddress(noToken, c.tag.tagAddress)
      ? "NO"
      : null
    if (side) {
      matches[c.tag.id] = { protocol: "trueo", detail: `${knownManager.label} market ${c.market} ${side} token` }
    }
  })
  return matches
}

// -----------------------------------------------------------------------------

// Returns, keyed by tag id, every EVM token that is a prediction-market outcome
// token. Non-EVM tags and non-token registries are ignored by the caller's
// contract, but are also skipped here defensively.
export const detectPredictionMarketTokens = async (
  tags: Tag[]
): Promise<PredictionMarketMatches> => {
  const matches: PredictionMarketMatches = {}

  const byChain: { [chainId: string]: Tag[] } = {}
  for (const tag of tags) {
    const chainCfg = findChainConfig(tag.chain)
    if (!chainCfg || chainCfg.namespaceId !== "eip155") continue
    if (tag.registry !== "tokens" || !isValidEvmAddress(tag.tagAddress)) continue
    if (!byChain[chainCfg.id]) byChain[chainCfg.id] = []
    byChain[chainCfg.id].push(tag)
  }

  for (const chainId of Object.keys(byChain)) {
    const chainCfg = findChainConfig(chainId) as ChainConfig
    const chainTags = byChain[chainId]
    const startedAt = Date.now()
    const registries = PREDICTION_MARKET_REGISTRIES[chainId] || []
    const seerFactories = registries.filter((r): r is SeerFactoryConfig => r.kind === "seer-market-factory")
    const thalesManagers = registries.filter((r): r is ThalesManagerConfig => r.kind === "thales-market-manager")
    const trueoManagers = registries.filter((r): r is TrueoManagerConfig => r.kind === "trueo-market-manager")

    const generic = await probeWrapped1155(chainCfg, chainTags)
    const chainMatches: PredictionMarketMatches[] = [generic]
    // The Seer enumeration is deliberately run over EVERY token of the chain,
    // not just the generic hits: it is the independent, exact check for the
    // protocol being farmed (10-25 s per chain, only when the chain has tokens).
    if (seerFactories.length > 0) {
      if (await hasMulticall(chainCfg)) {
        chainMatches.push(await probeSeer(chainCfg, seerFactories, chainTags))
      } else {
        // Thousands of one-off eth_calls: rely on the generic probe instead.
        console.warn(
          `[pm-detect] chain ${chainId}: no Multicall3, skipping Seer market enumeration (Seer tokens are still caught by the generic Wrapped1155 probe)`
        )
      }
    }
    // A token is one protocol's outcome token or none: skip generic hits here.
    const unmatched = chainTags.filter((t) => !generic[t.id])
    if (thalesManagers.length > 0 && unmatched.length > 0) {
      chainMatches.push(await probeThales(chainCfg, thalesManagers, unmatched))
    }
    if (trueoManagers.length > 0 && unmatched.length > 0) {
      chainMatches.push(await probeTrueo(chainCfg, trueoManagers, unmatched))
    }

    // Prefer the protocol-specific detail (names the market) over the generic one.
    for (const tag of chainTags) {
      const hits = chainMatches.map((m) => m[tag.id]).filter((m): m is PredictionMarketMatch => !!m)
      if (hits.length === 0) continue
      const specific = hits.find((h) => h.protocol !== "conditional-tokens") ?? hits[0]
      matches[tag.id] = {
        protocol: specific.protocol,
        detail:
          hits.length > 1
            ? `${specific.detail}; also ${hits
                .filter((h) => h !== specific)
                .map((h) => h.protocol)
                .join(", ")}`
            : specific.detail,
      }
    }

    const hitCount = chainTags.filter((t) => matches[t.id]).length
    console.log(
      `[pm-detect] chain ${chainId}: ${chainTags.length} token(s) checked, ${hitCount} prediction-market outcome token(s) ` +
        `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    )
  }

  return matches
}
