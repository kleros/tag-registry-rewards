import { ContractInfo, Tag, GasDune } from "./types"

// Naive, slow, needs no optimization
export const generateContractInfos = (
  tags: Tag[],
  gasDunes: GasDune[]
): ContractInfo[] => {
  const contractInfos: ContractInfo[] = tags.map((tag) => {
    const matchGas = gasDunes.find(
      (gasDune) =>
        gasDune.address === tag.tagAddress.toLocaleLowerCase() &&
        gasDune.chain === tag.chain
    )
    if (!matchGas)
      throw new Error(
        `Unable to find matched gasDune for tag ${tag.tagAddress} chain ${tag.chain}`
      )
    return { ...tag, gasUsed: matchGas.gas_spent }
  })

  return contractInfos
}
