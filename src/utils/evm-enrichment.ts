import { executeDuneSql, getDuneApiKey } from "./dune-client"
import conf from "../config"

const EVM_DUNE_SCHEMA_BY_CHAIN_ID: { [chainId: string]: string } = {
  "1": "ethereum",
  "10": "optimism",
  "100": "gnosis",
  "137": "polygon",
  "324": "zksync",
  "4326": "megaeth",
  "4663": "robinhood",
  "8453": "base",
  "42161": "arbitrum",
  "42220": "celo",
  "43114": "avalanche_c",
  "59144": "linea",
}

// An unbounded scan of ethereum/base/arbitrum transactions blows past the free
// tier's execution cap. Filtering on block_time lets Dune prune partitions.
const getEvmTxLookbackDays = (): number | null => {
  const raw = conf.EVM_TX_LOOKBACK_DAYS
  if (!raw || raw.trim() === "" || raw.trim() === "0") return null // null = all-time
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(
      `Invalid EVM_TX_LOOKBACK_DAYS="${raw}". Expected a positive number or empty for all-time.`
    )
  }
  return days
}

const isValidEvmAddress = (address: string): boolean =>
  /^0x[a-fA-F0-9]{40}$/.test(String(address || ""))

export interface EvmEnrichment {
  txCount: number
}

export const enrichAllEvmAddresses = async (
  addressesByChain: { [chainId: string]: string[] }
): Promise<{ [chainId: string]: { [addressLower: string]: EvmEnrichment } }> => {
  const output: { [chainId: string]: { [addressLower: string]: EvmEnrichment } } = {}

  const chainEntries: { chainId: string; schema: string; addresses: string[] }[] = []
  for (const chainId of Object.keys(addressesByChain)) {
    const schema = EVM_DUNE_SCHEMA_BY_CHAIN_ID[String(chainId)]
    if (!schema) {
      console.warn(`[evm] No Dune schema mapping for chainId=${chainId}, using 0 txCount`)
      output[chainId] = {}
      continue
    }
    const normalized = Array.from(
      new Set(
        addressesByChain[chainId]
          .map((a) => String(a || "").toLowerCase())
          .filter(isValidEvmAddress)
      )
    )
    output[chainId] = {}
    for (const addr of normalized) {
      output[chainId][addr] = { txCount: 0 }
    }
    if (normalized.length > 0) {
      chainEntries.push({ chainId, schema, addresses: normalized })
    }
  }

  if (chainEntries.length === 0) return output

  const duneApiKey = getDuneApiKey()

  const lookbackDays = getEvmTxLookbackDays()
  const timeFilter = lookbackDays
    ? `  AND block_time >= now() - INTERVAL '${lookbackDays}' day\n`
    : ""
  if (lookbackDays) {
    console.log(`[evm] Using lookback window of ${lookbackDays} days`)
  } else {
    console.log(
      `[evm] Using all-time tx counts (no EVM_TX_LOOKBACK_DAYS set) — high-traffic chains often exceed the free tier's execution limit`
    )
  }

  // One execution per chain. A single UNION ALL over every chain blows past the
  // free tier's 2 minute execution cap, and so does an unbounded scan of a
  // high-traffic chain — see EVM_TX_LOOKBACK_DAYS.
  let chainIndex = 0
  for (const { chainId, schema, addresses } of chainEntries) {
    chainIndex += 1
    const inList = addresses
      .map((a) => `from_hex(replace('${a}', '0x', ''))`)
      .join(", ")

    const sql =
      `SELECT lower('0x' || to_hex("to")) AS address, COUNT(*) AS tx_count\n` +
      `FROM ${schema}.transactions\n` +
      `WHERE success = TRUE AND "to" IN (${inList})\n` +
      `${timeFilter}` +
      `GROUP BY 1`

    console.log(
      `[evm] chain ${chainIndex}/${chainEntries.length} ${schema} (chainId=${chainId}), ${addresses.length} addresses`
    )

    // A failed lookup used to fall back to txCount=0, which silently reprices
    // every submission on this chain as an unused contract. Rewards are money:
    // abort the run instead of paying out on fabricated zeros.
    let rows: any[]
    try {
      rows = await executeDuneSql(duneApiKey, sql, `evm-${schema}`)
    } catch (err) {
      throw new Error(
        `[evm] chain ${schema} (chainId=${chainId}) tx count lookup failed for ${addresses.length} addresses: ${
          (err as Error).message
        }`
      )
    }

    for (const row of rows) {
      const address = String(row.address || "").toLowerCase()
      if (!isValidEvmAddress(address)) continue
      output[chainId][address] = {
        txCount: Number(row.tx_count || 0),
      }
    }
  }

  return output
}
