import { Tag } from "../types"
import { executeDuneSql, getDuneApiKey } from "./dune-client"
import conf from "../config"

const SOLANA_TX_CHUNK_SIZE = 25
const SOLANA_HOLDERS_CHUNK_SIZE = 50
const SOLANA_DUNE_CONCURRENCY = 1

const getSolanaTxLookbackDays = (): number | null => {
  const raw = conf.SOLANA_TX_LOOKBACK_DAYS
  if (!raw || raw.trim() === "" || raw.trim() === "0") return null // null = all-time
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`Invalid SOLANA_TX_LOOKBACK_DAYS="${raw}". Expected a positive number or empty for all-time.`)
  }
  return days
}

const splitChunks = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const runWithConcurrency = async <T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> => {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      results[idx] = await tasks[idx]()
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

const getBatchTotalTxns = async (
  apiKey: string,
  addresses: string[]
): Promise<{ [address: string]: number }> => {
  if (addresses.length === 0) return {}

  const lookbackDays = getSolanaTxLookbackDays()
  const timeFilter = lookbackDays
    ? `AND block_date >= CURRENT_DATE - INTERVAL '${lookbackDays}' day`
    : ""

  if (lookbackDays) {
    console.log(`[solana-tx] Using lookback window of ${lookbackDays} days`)
  } else {
    console.log(`[solana-tx] Using all-time tx counts (no SOLANA_TX_LOOKBACK_DAYS set — may be slow)`)
  }

  const result: { [address: string]: number } = {}
  const chunks = splitChunks(addresses, SOLANA_TX_CHUNK_SIZE)

  console.log(
    `[solana-tx] ${chunks.length} chunks of up to ${SOLANA_TX_CHUNK_SIZE} addresses, concurrency=${SOLANA_DUNE_CONCURRENCY}`
  )

  const tasks = chunks.map((chunk, idx) => async () => {
    console.log(
      `[solana-tx] chunk ${idx + 1}/${chunks.length} addresses=${chunk.length}`
    )
    const inList = chunk.map((a) => `'${a}'`).join(", ")
    const sql = `
SELECT address, approx_distinct(tx_id) AS total_txns
FROM solana.account_activity
WHERE address IN (${inList})
  AND tx_success = true
  ${timeFilter}
GROUP BY address
`
    return executeDuneSql(apiKey, sql, `solana-tx-${idx + 1}`)
  })

  const allRows = await runWithConcurrency(tasks, SOLANA_DUNE_CONCURRENCY)
  for (const rows of allRows) {
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
  const chunks = splitChunks(mintAddresses, SOLANA_HOLDERS_CHUNK_SIZE)

  const tasks = chunks.map((chunk, idx) => async () => {
    console.log(
      `[solana-holders] chunk ${idx + 1}/${chunks.length} mints=${chunk.length}`
    )
    const inList = chunk.map((a) => `'${a}'`).join(", ")
    const sql = `
SELECT token_mint_address, COUNT(DISTINCT token_balance_owner) AS total_holders
FROM solana_utils.token_accounts
WHERE token_mint_address IN (${inList})
GROUP BY token_mint_address
`
    return executeDuneSql(apiKey, sql, `solana-holders-${idx + 1}`)
  })

  const allRows = await runWithConcurrency(tasks, SOLANA_DUNE_CONCURRENCY)
  for (const rows of allRows) {
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
    let totalHolders: number | null = null
    if (tag.registry === "tokens") {
      const holders = holderCountMap[tag.tagAddress]
      if (holders === undefined) {
        console.warn(
          `[solana-batch] No holder data returned by Dune for token mint ${tag.tagAddress} — defaulting to 0 (will be dropped by holder threshold)`
        )
        totalHolders = 0
      } else {
        totalHolders = holders
      }
    }
    result[cacheKey] = {
      txCount: txCountMap[tag.tagAddress] || 0,
      totalHolders,
    }
  }

  return result
}
