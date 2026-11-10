import { ethers } from "ethers"
import { ChainConfig, FilterCheckReason, Tag } from "../types"
import { sleep } from "../transaction-sender"
import { classifyError, ensureChainId, rpcsForChain } from "./prediction-market-detection"
import { errorMessage } from "./runtime-helpers"
import { defaultSolanaRpcPool, isSolanaAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./solana-rpc-enrichment"
import { SolanaRpcPool } from "./solana-rpc"

// One provider per RPC URL: the chain id is known (no network detection call),
// and a call that hangs fails after 30 s, not after ethers' 120 s. Before its
// first call, each URL's chain id is checked once (shared with the
// prediction-market probes): a fallback filed under the wrong chain would
// answer getCode with 0x and have a real contract excluded as an EOA.
const providers: { [rpc: string]: ethers.providers.StaticJsonRpcProvider } = {}

const providerFor = (url: string, chainId: string): ethers.providers.StaticJsonRpcProvider => {
  if (!providers[url]) providers[url] = new ethers.providers.StaticJsonRpcProvider({ url, timeout: 30000 }, Number(chainId))
  return providers[url]
}

const ATTEMPTS = 3

// Every check must get an answer. A tag kept because its chain's RPC failed
// would be rewarded without being checked (an EOA, a minimal proxy or an NFT
// taking a share of a pool-based reward), so a failing call is retried, on the
// chain's fallback RPCs too, then stops the run (before the slow transaction
// counts) naming the RPC. `answered` turns an error that is itself an answer
// (a revert) into a result.
const ask = async <T>(
  chainCfg: ChainConfig,
  what: string,
  call: (provider: ethers.providers.StaticJsonRpcProvider) => Promise<T>,
  answered?: (err: unknown) => T | undefined
): Promise<T> => {
  const urls = rpcsForChain(chainCfg)
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const provider = providerFor(urls[(attempt - 1) % urls.length], chainCfg.id)
      await ensureChainId(chainCfg, provider)
      return await call(provider)
    } catch (err) {
      const answer = answered ? answered(err) : undefined
      if (answer !== undefined) return answer
      lastError = err
      if (attempt < ATTEMPTS) await sleep(2 * attempt)
    }
  }
  throw new Error(
    `[filter] ${chainCfg.name} (${chainCfg.id}): no RPC answered ${what} (${ATTEMPTS} attempts on ${urls.join(", ")}; ` +
      `${errorMessage(lastError)}). The address tags of this chain cannot be checked: rerun, and if it keeps failing, ` +
      "set a working RPC for it in src/utils/chains.ts."
  )
}

const erc165 = new ethers.utils.Interface(["function supportsInterface(bytes4 interfaceID) view returns (bool)"])
// "OutOfGas": reth's wording ("EVM error: OutOfGas(…)")
const GAS_CAP = /out ?of ?gas|gas required exceeds|intrinsic gas|gas limit/i
// ERC-20 by the functions every ERC-20 must have (EIP-20: decimals() and
// symbol() are optional, and some tokens lack them).
const erc20 = new ethers.utils.Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
])
const BURN = "0x000000000000000000000000000000000000dEaD"
const ERC20_CALLS = [
  erc20.encodeFunctionData("totalSupply", []),
  erc20.encodeFunctionData("balanceOf", [BURN]),
  erc20.encodeFunctionData("allowance", [BURN, BURN]),
]
// A function no contract has (the hash of a name nobody uses).
const NO_SUCH_FUNCTION = ethers.utils.id("klerosCurateRewardsNoSuchFunction(uint256)").slice(0, 10) + "00".repeat(32)

// A call's answer, or null when the contract reverts (or burns all the gas).
// Any other failure is no answer about the contract: thrown, for `ask` to retry.
// A revert that carries data (Error(string), Panic(uint256), a custom error)
// comes back from ethers as the call's result, not as an error: a 4-byte
// selector and its arguments in whole 32-byte words, which no return value
// is. Taking those for answers made every contract whose fallback reverts with
// a reason "answer any call" (17 of October 2026's Address Tags entries:
// oracles, bridge messengers, vaults) and could make one look like an ERC-20.
const answerOf = async (p: ethers.providers.StaticJsonRpcProvider, to: string, data: string): Promise<string | null> => {
  try {
    const out = await p.call({ to, data })
    return ethers.utils.hexDataLength(out) % 32 === 4 ? null : out
  } catch (err) {
    if (classifyError(err) === "revert" || GAS_CAP.test(errorMessage(err))) return null
    throw err
  }
}
const isUint = (out: string | null): boolean => out !== null && ethers.utils.hexDataLength(out) >= 32

// Asks each of the chain's other RPCs, as far as they answer: a second
// opinion that cannot be had leaves the first one standing.
const secondOpinions = async <T>(
  chainCfg: ChainConfig,
  call: (p: ethers.providers.StaticJsonRpcProvider) => Promise<T>,
  enough: (answer: T) => boolean
): Promise<T | undefined> => {
  for (const url of rpcsForChain(chainCfg).slice(1)) {
    try {
      const p = providerFor(url, chainCfg.id)
      await ensureChainId(chainCfg, p)
      const answer = await call(p)
      if (enough(answer)) return answer
    } catch {
      // no second opinion from this one
    }
  }
  return undefined
}

const supportsErc721 = (out: string | null): boolean => {
  if (out === null) return false // reverted, or burned the gas: no ERC-165
  try {
    return Boolean(erc165.decodeFunctionResult("supportsInterface", out)[0])
  } catch {
    return false // an empty or malformed answer (a fallback function): no ERC-165
  }
}

// The interface checks of a contract, on one RPC, in order:
// - a contract that answers a function it cannot have answers anything (a
//   fallback returning data): its answers to supportsInterface() or
//   totalSupply() would prove nothing, so neither check below can judge it,
//   and a token or an NFT given such a fallback would pass them both. No
//   contract an Address Tag names needs one (proxies forward to code that
//   reverts on an unknown function): excluded, under its own reason in the
//   filter report, for a look by hand;
// - ERC-721 by ERC-165 (most contracts have no supportsInterface and revert,
//   and some burn all the gas trying: both mean no ERC-165);
// - ERC-20 by the functions every ERC-20 has: totalSupply(), balanceOf() and
//   allowance() all answer. The rules never rewarded an ERC-20 in Address
//   Tags, but until November 2026 only a name tag ending in "token" caught
//   one, and October 2026 paid the Treat token, tagged "TREAT".
// `empty`: some call came back "0x", which is also what a node behind a load
// balancer answers for a contract it has not synced yet.
const interfaceVerdict = async (
  p: ethers.providers.StaticJsonRpcProvider,
  address: string
): Promise<{ reason: FilterCheckReason | null; empty: boolean }> => {
  let empty = false
  const callOf = async (data: string) => {
    const out = await answerOf(p, address, data)
    if (out === "0x") empty = true
    return out
  }
  if (isUint(await callOf(NO_SUCH_FUNCTION))) return { reason: "answers any call (catch-all)", empty }
  if (supportsErc721(await callOf(erc165.encodeFunctionData("supportsInterface", ["0x80ac58cd"])))) return { reason: "erc-721 contract", empty }
  for (const data of ERC20_CALLS) {
    if (!isUint(await callOf(data))) return { reason: null, empty }
  }
  return { reason: "erc-20 contract", empty }
}

// A Solana address registered in Address Tags that is a token mint (an account
// of an SPL token program holding a mint: 82 bytes, or a Token-2022 mint with
// extensions, whose byte 165 says "mint") is a token, Solana's ERC-20.
// One pool per SOLANA_RPC_URLS: its URLs' pacing is shared by every check.
let solanaPool: { urls: string; pool: SolanaRpcPool } | null = null
const isSplMint = async (address: string): Promise<boolean> => {
  const urls = String(process.env.SOLANA_RPC_URLS || "")
  if (solanaPool?.urls !== urls) solanaPool = { urls, pool: defaultSolanaRpcPool() }
  const res = await solanaPool.pool.call<{ value?: ({ owner?: string; data?: [string, string] } | null)[] }>("getMultipleAccounts", [
    [address],
    { encoding: "base64", commitment: "confirmed" },
  ])
  if (!res || !Array.isArray(res.value) || res.value.length !== 1) {
    throw new Error(`[filter] unexpected getMultipleAccounts answer for ${address}`)
  }
  const account = res.value[0]
  if (!account || (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM)) return false
  const data = Buffer.from(account.data ? account.data[0] : "", "base64")
  return data.length === 82 || (account.owner === TOKEN_2022_PROGRAM && data.length > 165 && data[165] === 1)
}

export const getAddressTagExclusionReason = async (
  tag: Tag,
  chainCfg: ChainConfig
): Promise<FilterCheckReason | null> => {
  if (chainCfg.namespaceId === "solana") {
    // An RPC failure stops the run, as for the EVM checks: an unchecked token
    // would be rewarded.
    const address = String(tag.tagAddress || "").trim()
    return isSolanaAddress(address) && (await isSplMint(address)) ? "solana token mint" : null
  }

  // Lowercase: a wrong checksum in the registered address is no reason to
  // skip the check. Something that is no address holds no contract.
  const address = String(tag.tagAddress || "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return "not a contract (getCode == 0x)"
  }

  // No code is also what a node that has not synced the contract answers: the
  // chain's other RPCs are asked before an address is taken for an EOA.
  let bytecode = await ask(chainCfg, `eth_getCode for ${address}`, (p) => p.getCode(address))
  if (!bytecode || bytecode === "0x") {
    bytecode = (await secondOpinions(chainCfg, (p) => p.getCode(address), (code) => !!code && code !== "0x")) || "0x"
    if (bytecode === "0x") return "not a contract (getCode == 0x)"
  }

  const bytecodeNormalized = bytecode.toLowerCase().replace(/^0x/, "")
  if (bytecodeNormalized.length === 90) {
    const match = /^363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(
      bytecodeNormalized
    )
    if (match) {
      const implementation = `0x${match[1]}`
      const implementationCode = await ask(chainCfg, `eth_getCode for ${implementation}`, (p) => p.getCode(implementation))
      if (implementationCode && implementationCode !== "0x") {
        return "eip-1167 minimal proxy"
      }
    }
  }

  // A failure that is no answer about the contract (a timeout, an HTTP error,
  // an RPC refusing the request) is retried, on the fallback RPCs too, then
  // stops the run: never taken for an answer, or a token would be rewarded.
  // A verdict that rests on an empty answer is asked again of the chain's
  // other RPCs: if any of them sees a token, an NFT or a catch-all, it is one.
  const first = await ask(chainCfg, `the interface checks of ${address}`, (p) => interfaceVerdict(p, address))
  if (first.reason || !first.empty) return first.reason
  const other = await secondOpinions(chainCfg, (p) => interfaceVerdict(p, address), (v) => v.reason !== null)
  return other ? other.reason : null
}
