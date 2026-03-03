import fetch from "node-fetch"
import conf from "../config"

const DEFAULT_DUNE_BASE_URL = "https://api.dune.com/api/v1"
const DUNE_EVM_ADDRESS_CHUNK_SIZE = 150

type DuneMethod = "GET" | "POST"

const duneBaseUrl = (conf.DUNE_BASE_URL || DEFAULT_DUNE_BASE_URL).replace(/\/+$/, "")
const dunePerformance = conf.DUNE_QUERY_PERFORMANCE || "medium"
const dunePollIntervalMs = Number(conf.DUNE_POLL_INTERVAL_SECONDS || "2") * 1000
const duneMaxPolls = Number(conf.DUNE_MAX_POLLS || "600")
const duneHttpMaxRetries = Number(conf.DUNE_HTTP_MAX_RETRIES || "6")
const duneHttpRetryBaseMs = Number(conf.DUNE_HTTP_RETRY_BASE_MS || "2000")
const duneStatusLogEveryPolls = Number(conf.DUNE_STATUS_LOG_EVERY_POLLS || "5")

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

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const isRetryableStatus = (status: number): boolean => {
  return status === 429 || status >= 500
}

const isRetryableNetworkError = (error: unknown): boolean => {
  const message = String((error as Error)?.message || "").toLowerCase()
  return (
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("enotfound") ||
    message.includes("socket hang up") ||
    message.includes("network")
  )
}

const getRetryDelayMs = (attempt: number): number => {
  const exponential = duneHttpRetryBaseMs * Math.pow(2, Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * 500)
  return Math.min(30000, exponential + jitter)
}

const duneRequest = async (
  apiKey: string,
  method: DuneMethod,
  path: string,
  payload?: Record<string, unknown>
): Promise<any> => {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= duneHttpMaxRetries; attempt++) {
    try {
      const response = await fetch(`${duneBaseUrl}${path}`, {
        method,
        headers: {
          "X-Dune-Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: payload ? JSON.stringify(payload) : undefined,
      })
      const contentType = response.headers.get("content-type") || ""
      const body = contentType.includes("application/json")
        ? await response.json()
        : await response.text()

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < duneHttpMaxRetries) {
          const waitMs = getRetryDelayMs(attempt)
          console.warn(
            `[dune-evm] ${method} ${path} status=${response.status}, retry ${attempt}/${duneHttpMaxRetries} in ${waitMs}ms`
          )
          await delay(waitMs)
          continue
        }
        throw new Error(
          `Dune request failed: ${response.status} ${JSON.stringify(body)}`
        )
      }
      return body
    } catch (err) {
      lastError = err as Error
      if (attempt < duneHttpMaxRetries && isRetryableNetworkError(err)) {
        const waitMs = getRetryDelayMs(attempt)
        console.warn(
          `[dune-evm] ${method} ${path} network error "${lastError.message}", retry ${attempt}/${duneHttpMaxRetries} in ${waitMs}ms`
        )
        await delay(waitMs)
        continue
      }
      throw err
    }
  }

  throw new Error(
    `Dune request failed after ${duneHttpMaxRetries} attempts: ${
      lastError?.message || "unknown error"
    }`
  )
}

const executeDuneSql = async (apiKey: string, sql: string): Promise<any[]> => {
  const execute = await duneRequest(apiKey, "POST", "/sql/execute", {
    sql,
    performance: dunePerformance,
  })
  const executionId = execute.execution_id
  if (!executionId) {
    throw new Error(`No execution_id returned by Dune: ${JSON.stringify(execute)}`)
  }
  console.log(`[evm] Dune query submitted: execution_id=${executionId}`)

  let state = ""
  for (let poll = 0; poll < duneMaxPolls; poll++) {
    await delay(dunePollIntervalMs)
    const status = await duneRequest(
      apiKey,
      "GET",
      `/execution/${executionId}/status`
    )
    state = status.state
    if (poll === 0 || (poll + 1) % duneStatusLogEveryPolls === 0) {
      console.log(
        `[evm] Dune execution ${executionId} poll ${poll + 1}/${duneMaxPolls}: ${state}`
      )
    }
    if (state === "QUERY_STATE_COMPLETED") {
      break
    }
    if (
      state === "QUERY_STATE_FAILED" ||
      state === "QUERY_STATE_CANCELLED" ||
      state === "QUERY_STATE_EXPIRED"
    ) {
      throw new Error(`Dune execution ${executionId} failed with state ${state}`)
    }
  }

  if (state !== "QUERY_STATE_COMPLETED") {
    throw new Error(`Dune execution ${executionId} did not complete in time`)
  }

  const results = await duneRequest(
    apiKey,
    "GET",
    `/execution/${executionId}/results`
  )
  return (((results || {}).result || {}).rows || []) as any[]
}

const isValidEvmAddress = (address: string): boolean =>
  /^0x[a-fA-F0-9]{40}$/.test(String(address || ""))

const splitChunks = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const buildBatchTxCountSql = (
  schema: string,
  addresses: string[]
): string => {
  const valuesSql = addresses
    .map(
      (address) =>
        `(from_hex(replace('${address.toLowerCase()}', '0x', '')))`
    )
    .join(",\n    ")

  return `
WITH input(address) AS (
  VALUES
    ${valuesSql}
),
counts AS (
  SELECT lower(to_hex(t.to)) AS address_hex, COUNT(*) AS total_txs
  FROM ${schema}.transactions t
  JOIN input i ON t.to = i.address
  GROUP BY 1
)
SELECT lower('0x' || to_hex(i.address)) AS address, COALESCE(c.total_txs, 0) AS total_txs
FROM input i
LEFT JOIN counts c ON c.address_hex = lower(to_hex(i.address))
`
}

export interface EvmEnrichment {
  txCount: number
}

export const enrichEvmAddressesBatch = async (
  chainId: string,
  addresses: string[]
): Promise<{ [addressLower: string]: EvmEnrichment }> => {
  const output: { [addressLower: string]: EvmEnrichment } = {}
  const normalized = Array.from(
    new Set(
      addresses
        .map((address) => String(address || "").toLowerCase())
        .filter(isValidEvmAddress)
    )
  )

  for (const address of normalized) {
    output[address] = { txCount: 0 }
  }
  if (normalized.length === 0) return output

  const duneApiKey = conf.DUNE_API_KEY || ""
  if (!duneApiKey.trim()) {
    throw new Error("DUNE_API_KEY is required to enrich EVM addresses")
  }

  const schema = EVM_DUNE_SCHEMA_BY_CHAIN_ID[String(chainId)]
  if (!schema) {
    console.warn(`[evm] No Dune schema mapping for chainId=${chainId}, using 0 txCount`)
    return output
  }

  const chunks = splitChunks(normalized, DUNE_EVM_ADDRESS_CHUNK_SIZE)
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    const sql = buildBatchTxCountSql(schema, chunk)
    console.log(
      `[evm] Dune batch lookup chain=${chainId} schema=${schema} chunk=${index + 1}/${chunks.length} addresses=${chunk.length}`
    )
    const rows = await executeDuneSql(duneApiKey, sql)

    for (const row of rows) {
      const address = String(row.address || "").toLowerCase()
      if (!isValidEvmAddress(address)) continue
      output[address] = {
        txCount: Number(row.total_txs || 0),
      }
    }
  }

  return output
}
