import { ContractInfo, Tag, GasDune } from "./types"

// Naive, slow, needs no optimization
export const generateContractInfos = (
  tags: Tag[],
  gasDunes: GasDune[]
): ContractInfo[] => {
  const contractInfos: ContractInfo[] = tags.map((tag) => {
    const isEvm = tag.tagAddress.startsWith("0x") || tag.tagAddress.startsWith("0X")
    const normalizedTagAddress = isEvm
      ? tag.tagAddress.toLowerCase().replace(/^0x/i, "")
      : tag.tagAddress
    const matchGas = gasDunes.find(
      (gasDune) =>
        (isEvm ? gasDune.address.toLowerCase() : gasDune.address) === normalizedTagAddress &&
        String(gasDune.chain).toLowerCase() === String(tag.chain).toLowerCase()
    )
    if (!matchGas) {
      // a valid contract might not have had any tx! in this case, txCount is zero.
      // sample: https://gnosisscan.io/address/0xC92E8bdf79f0507f65a392b0ab4667716BFE0110
      console.log(
        `Unable to find matched gasDune for tag ${tag.tagAddress} chain ${tag.chain}`
      )
      return { ...tag, txCount: 0 }
    }

    return { ...tag, txCount: matchGas.tx_count }
  })

  return contractInfos
}
