import { executeDuneSql, getDuneApiKey } from "./dune-client"

const EVM_DUNE_SCHEMA_BY_CHAIN_ID: { [chainId: string]: string } = {
  "1": "ethereum",
  "10": "optimism",
  "100": "gnosis",
  "137": "polygon",
  "324": "zksync",
  "4326": "megaeth",
  "8453": "base",
  "42161": "arbitrum",
  "42220": "celo",
  "43114": "avalanche_c",
  "534352": "scroll",
  "59144": "linea",
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

  const unionParts: string[] = []
  let totalAddresses = 0
  for (const { chainId, schema, addresses } of chainEntries) {
    totalAddresses += addresses.length
    const inList = addresses
      .map((a) => `from_hex(replace('${a}', '0x', ''))`)
      .join(", ")

    unionParts.push(
      `SELECT lower('0x' || to_hex("to")) AS address, COUNT(*) AS tx_count, ${chainId} AS chain\n` +
      `  FROM ${schema}.transactions\n` +
      `  WHERE success = TRUE AND "to" IN (${inList})\n` +
      `  GROUP BY 1`
    )
  }

  console.log(
    `[evm] Dune UNION ALL query: ${chainEntries.length} chains, ${totalAddresses} addresses`
  )

  const sql = `WITH unioned AS (\n${unionParts.join("\n  UNION ALL\n")}\n)\nSELECT address, tx_count, CAST(chain AS varchar) AS chain\nFROM unioned`
  const rows = await executeDuneSql(duneApiKey, sql, "evm")

  for (const row of rows) {
    const address = String(row.address || "").toLowerCase()
    const chainId = String(row.chain || "")
    if (!chainId || !output[chainId] || !isValidEvmAddress(address)) continue
    output[chainId][address] = {
      txCount: Number(row.tx_count || 0),
    }
  }

  return output
}
