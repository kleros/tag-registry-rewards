import { ethers } from "ethers"
import { ChainConfig, FilterCheckReason, Tag } from "../types"

const providerPromiseCache: { [rpc: string]: Promise<ethers.providers.JsonRpcProvider> } = {}

const getOrCreateProvider = (rpc: string): Promise<ethers.providers.JsonRpcProvider> => {
  if (!providerPromiseCache[rpc]) {
    providerPromiseCache[rpc] = (async () => {
      const provider = new ethers.providers.JsonRpcProvider(rpc)
      await provider.detectNetwork()
      return provider
    })()
    // Don't cache rejected promises — allow retry on next call
    providerPromiseCache[rpc].catch(() => {
      delete providerPromiseCache[rpc]
    })
  }
  return providerPromiseCache[rpc]
}

export const getAddressTagExclusionReason = async (
  tag: Tag,
  chainCfg: ChainConfig
): Promise<FilterCheckReason | null> => {
  if (chainCfg.namespaceId === "solana") {
    return null
  }

  try {
    const provider = await getOrCreateProvider(chainCfg.rpc)
    const bytecode = await provider.getCode(tag.tagAddress)

    if (!bytecode || bytecode === "0x") {
      return "not a contract (getCode == 0x)"
    }

    const bytecodeNormalized = bytecode.toLowerCase().replace(/^0x/, "")
    if (bytecodeNormalized.length === 90) {
      const match = /^363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(
        bytecodeNormalized
      )
      if (match) {
        const implementation = ethers.utils.getAddress(match[1])
        const implementationCode = await provider.getCode(implementation)
        if (implementationCode && implementationCode !== "0x") {
          return "eip-1167 minimal proxy"
        }
      }
    }

    const contract = new ethers.Contract(
      tag.tagAddress,
      ["function supportsInterface(bytes4 interfaceID) external view returns (bool)"],
      provider
    )
    const isERC721 = await contract.supportsInterface("0x80ac58cd")
    if (isERC721) {
      return "erc-721 contract"
    }
  } catch {
    // Contract doesn't support ERC-165 supportsInterface — this is normal for most contracts.
    // Tag is kept as rewarded.
  }

  return null
}
