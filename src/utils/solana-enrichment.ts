import { Tag } from "../types"
import { executeDuneSql, getDuneApiKey } from "./dune-client"

const SOLANA_CHUNK_SIZE = 50

const splitChunks = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const getBatchTotalTxns = async (
  apiKey: string,
  addresses: string[]
): Promise<{ [address: string]: number }> => {
  if (addresses.length === 0) return {}

  const result: { [address: string]: number } = {}
  const chunks = splitChunks(addresses, SOLANA_CHUNK_SIZE)

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    console.log(
      `[solana-tx] chunk ${idx + 1}/${chunks.length} addresses=${chunk.length}`
    )
    const valuesList = chunk.map((a) => `('${a}')`).join(",\n    ")
    const sql = `
WITH input(address) AS (
  VALUES
    ${valuesList}
)
SELECT aa.address, approx_distinct(aa.tx_id) AS total_txns
FROM solana.account_activity aa
JOIN input i ON aa.address = i.address
WHERE aa.tx_success = true
GROUP BY aa.address
`
    const rows = await executeDuneSql(apiKey, sql, "solana-tx-batch")
    for (const row of rows) {
      result[String(row.address || "")] = Number(row.total_txns || 0)
    }
  }
  return result
}

const getBatchTotalHolders = async (
  apiKey: string,
  mintAddresses: string[]
): Promise<{ [address: string]: number }> => {
  if (mintAddresses.length === 0) return {}

  const result: { [address: string]: number } = {}
  const chunks = splitChunks(mintAddresses, SOLANA_CHUNK_SIZE)

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]
    console.log(
      `[solana-holders] chunk ${idx + 1}/${chunks.length} mints=${chunk.length}`
    )
    const valuesList = chunk.map((a) => `('${a}')`).join(",\n    ")
    const sql = `
WITH input(mint) AS (
  VALUES
    ${valuesList}
)
SELECT ta.token_mint_address, COUNT(DISTINCT ta.token_balance_owner) AS total_holders
FROM solana_utils.token_accounts ta
JOIN input i ON ta.token_mint_address = i.mint
GROUP BY ta.token_mint_address
`
    const rows = await executeDuneSql(apiKey, sql, "solana-holders-batch")
    for (const row of rows) {
      result[String(row.token_mint_address || "")] = Number(
        row.total_holders || 0
      )
    }
  }
  return result
}

export interface SolanaEnrichment {
  txCount: number
  totalHolders: number | null
}

export const enrichSolanaTagsBatch = async (
  tags: Tag[]
): Promise<{ [cacheKey: string]: SolanaEnrichment }> => {
  const duneApiKey = getDuneApiKey()
  const result: { [cacheKey: string]: SolanaEnrichment } = {}

  const allAddresses = Array.from(
    new Set(tags.map((t) => t.tagAddress))
  )
  const tokenMints = Array.from(
    new Set(
      tags
        .filter((t) => t.registry === "tokens")
        .map((t) => t.tagAddress)
            )
  )

  console.log(
    `[solana-batch] Fetching tx counts for ${allAddresses.length} addresses and holder counts for ${tokenMints.length} token mints`
  )

  const txCountMap = await getBatchTotalTxns(duneApiKey, allAddresses)
  const holderCountMap =
    tokenMints.length > 0
      ? await getBatchTotalHolders(duneApiKey, tokenMints)
      : {}

  for (const tag of tags) {
    const cacheKey = `${tag.chain}:${tag.registry}:${tag.tagAddress}`
    result[cacheKey] = {
      txCount: txCountMap[tag.tagAddress] || 0,
      totalHolders:
        tag.registry === "tokens"
          ? holderCountMap[tag.tagAddress] ?? 0
          : null,
    }
  }

  return result
}
