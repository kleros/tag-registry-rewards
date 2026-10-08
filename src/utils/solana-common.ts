// Tokens-registry Solana mints below this many distinct holders are not rewarded.
export const SOLANA_HOLDER_THRESHOLD = 5000

export interface SolanaEnrichment {
  txCount: number
  // Distinct holders for Tokens-registry mints, null for other registries.
  totalHolders: number | null
}
