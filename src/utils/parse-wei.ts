import { BigNumber } from "ethers"

// Parse a pool/cap env value as a non-negative integer wei amount. Shared by
// the reward builders so the validation can't drift between them.
export const parseWei = (key: string, raw: string): BigNumber => {
  try {
    const value = BigNumber.from(raw.trim())
    if (value.isNegative()) throw new Error("negative")
    return value
  } catch {
    throw new Error(`Invalid ${key}="${raw}". Expected a non-negative integer (wei).`)
  }
}
