import fetch from "node-fetch"
import conf from "../config"
import { Tag } from "../types"

const DEFAULT_DUNE_BASE_URL = "https://api.dune.com/api/v1"

type DuneMethod = "GET" | "POST"

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const duneBaseUrl = (conf.DUNE_BASE_URL || DEFAULT_DUNE_BASE_URL).replace(/\/+$/, "")
const dunePerformance = conf.DUNE_QUERY_PERFORMANCE || "medium"
const dunePollIntervalMs = Number(conf.DUNE_POLL_INTERVAL_SECONDS || "2") * 1000
const duneMaxPolls = Number(conf.DUNE_MAX_POLLS || "600")
const duneHttpMaxRetries = Number(conf.DUNE_HTTP_MAX_RETRIES || "6")
const duneHttpRetryBaseMs = Number(conf.DUNE_HTTP_RETRY_BASE_MS || "2000")
const duneStatusLogEveryPolls = Number(conf.DUNE_STATUS_LOG_EVERY_POLLS || "5")

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
            `[dune] ${method} ${path} status=${response.status}, retry ${attempt}/${duneHttpMaxRetries} in ${waitMs}ms`
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
          `[dune] ${method} ${path} network error "${lastError.message}", retry ${attempt}/${duneHttpMaxRetries} in ${waitMs}ms`
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
  console.log(`[solana] Dune query submitted: execution_id=${executionId}`)

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
        `[solana] Dune execution ${executionId} poll ${poll + 1}/${duneMaxPolls}: ${state}`
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

const getTotalTxns = async (apiKey: string, address: string): Promise<number> => {
  const rows = await executeDuneSql(
    apiKey,
    `SELECT COUNT(*) AS total_txns FROM solana.account_activity WHERE address = '${address}'`
  )
  if (!rows.length) return 0
  return Number(rows[0].total_txns || 0)
}

const getTotalHolders = async (
  apiKey: string,
  mintAddress: string
): Promise<number> => {
  const rows = await executeDuneSql(
    apiKey,
    "SELECT COUNT(DISTINCT token_balance_owner) AS total_holders " +
      "FROM solana_utils.token_accounts " +
      `WHERE token_mint_address = '${mintAddress}'`
  )
  if (!rows.length) return 0
  return Number(rows[0].total_holders || 0)
}

export interface SolanaEnrichment {
  txCount: number
  totalHolders: number | null
}

export const enrichSolanaTag = async (tag: Tag): Promise<SolanaEnrichment> => {
  const duneApiKey = conf.DUNE_API_KEY || ""
  if (!duneApiKey.trim()) {
    throw new Error("DUNE_API_KEY is required to enrich Solana addresses")
  }

  const base: SolanaEnrichment = {
    txCount: await getTotalTxns(duneApiKey, tag.tagAddress),
    totalHolders: null,
  }

  if (tag.registry === "tokens") {
    base.totalHolders = await getTotalHolders(duneApiKey, tag.tagAddress)
  }

  return base
}
