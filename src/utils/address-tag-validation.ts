import { ethers } from "ethers"
import { ChainConfig, FilterCheckReason, Tag } from "../types"
import { sleep } from "../transaction-sender"
import { classifyError, rpcsForChain } from "./prediction-market-detection"
import { errorMessage } from "./runtime-helpers"

// One provider per RPC URL: the chain id is known (no network detection call),
// and a call that hangs fails after 30 s, not after ethers' 120 s.
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
      return await call(providerFor(urls[(attempt - 1) % urls.length], chainCfg.id))
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
const GAS_CAP = /out of gas|gas required exceeds|intrinsic gas|gas limit/i

export const getAddressTagExclusionReason = async (
  tag: Tag,
  chainCfg: ChainConfig
): Promise<FilterCheckReason | null> => {
  if (chainCfg.namespaceId === "solana") {
    return null
  }

  // Lowercase: a wrong checksum in the registered address is no reason to
  // skip the check. Something that is no address holds no contract.
  const address = String(tag.tagAddress || "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return "not a contract (getCode == 0x)"
  }

  const bytecode = await ask(chainCfg, `eth_getCode for ${address}`, (p) => p.getCode(address))
  if (!bytecode || bytecode === "0x") {
    return "not a contract (getCode == 0x)"
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

  // ERC-721 by ERC-165. Most contracts have no supportsInterface and revert,
  // and some burn all the gas trying: both mean no ERC-165, so kept. A
  // transport failure (timeout, HTTP error) is no answer: retried like the
  // rest, never taken for one, or an NFT would be rewarded.
  const data = erc165.encodeFunctionData("supportsInterface", ["0x80ac58cd"])
  const isErc721 = await ask(
    chainCfg,
    `supportsInterface for ${address}`,
    async (p) => {
      const out = await p.call({ to: address, data })
      try {
        return Boolean(erc165.decodeFunctionResult("supportsInterface", out)[0])
      } catch {
        return false // an empty or malformed answer (a fallback function): no ERC-165
      }
    },
    (err) => (classifyError(err) !== "transport" || GAS_CAP.test(errorMessage(err)) ? false : undefined)
  )
  return isErc721 ? "erc-721 contract" : null
}
