import { executeDuneSql, getDuneApiKey } from "./dune-client"
import { countEvmTxsWithHypersync, HypersyncChainReport, HYPERSYNC_DEFINITION } from "./hypersync-enrichment"

// EVM tx counts per chain and address. Provider: EVM_TX_PROVIDER=hypersync
// (default, free Envio token) or dune (paid plan since Sept 2026).

const EVM_DUNE_SCHEMA_BY_CHAIN_ID: { [chainId: string]: string } = {
  "1": "ethereum",
  "10": "optimism",
  "100": "gnosis",
  "137": "polygon",
  "324": "zksync",
  "999": "hyperevm",
  "4326": "megaeth",
  "4663": "robinhood",
  "5042": "arc",
  "8453": "base",
  "42161": "arbitrum",
  "42220": "celo",
  "43114": "avalanche_c",
  "59144": "linea",
}

const DUNE_DEFINITION = 'Dune <chain>.transactions: success = TRUE and "to" = address, all-time'

const isValidEvmAddress = (address: string): boolean =>
  /^0x[a-fA-F0-9]{40}$/.test(String(address || ""))

export interface EvmEnrichment {
  txCount: number
}

export interface EvmProvenance {
  provider: "hypersync" | "dune"
  definition: string
  chains?: HypersyncChainReport[]
  cacheDir?: string
}

export interface EvmEnrichmentResult {
  byChain: { [chainId: string]: { [addressLower: string]: EvmEnrichment } }
  provenance: EvmProvenance
}

export const getEvmTxProvider = (): "hypersync" | "dune" => {
  const raw = String(process.env.EVM_TX_PROVIDER || "hypersync").trim().toLowerCase()
  if (raw === "hypersync" || raw === "dune") return raw
  throw new Error(`Invalid EVM_TX_PROVIDER="${raw}": expected "hypersync" or "dune"`)
}

const enrichEvmAddressesWithDune = async (
  addressesByChain: { [chainId: string]: string[] }
): Promise<{ [chainId: string]: { [addressLower: string]: EvmEnrichment } }> => {
  const output: { [chainId: string]: { [addressLower: string]: EvmEnrichment } } = {}

  const chainEntries: { chainId: string; schema: string; addresses: string[] }[] = []
  for (const chainId of Object.keys(addressesByChain)) {
    const schema = EVM_DUNE_SCHEMA_BY_CHAIN_ID[String(chainId)]
    if (!schema) {
      throw new Error(`[evm] No Dune schema mapping for chainId=${chainId}`)
    }
    const all = Array.from(new Set(addressesByChain[chainId].map((a) => String(a || "").trim().toLowerCase())))
    const normalized = all.filter(isValidEvmAddress)
    output[chainId] = {}
    // Invalid addresses keep the historical txCount 0, explicitly.
    for (const addr of all) {
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

// Every requested address (lowercased) gets an explicit entry; any failure
// throws instead of defaulting to 0, because the counts drive the payout split.
export const enrichAllEvmAddresses = async (
  addressesByChain: { [chainId: string]: string[] }
): Promise<EvmEnrichmentResult> => {
  const provider = getEvmTxProvider()
  if (provider === "dune") {
    return {
      byChain: await enrichEvmAddressesWithDune(addressesByChain),
      provenance: { provider, definition: DUNE_DEFINITION },
    }
  }
  const result = await countEvmTxsWithHypersync(addressesByChain)
  const byChain: EvmEnrichmentResult["byChain"] = {}
  for (const chainId of Object.keys(result.counts)) {
    byChain[chainId] = {}
    for (const address of Object.keys(result.counts[chainId])) {
      byChain[chainId][address] = { txCount: result.counts[chainId][address] }
    }
  }
  return {
    byChain,
    provenance: { provider, definition: HYPERSYNC_DEFINITION, chains: result.chains, cacheDir: result.cacheDir },
  }
}
