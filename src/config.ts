interface Config {
  XDAI_GTCR_SUBGRAPH_URL: string
  XDAI_REGISTRY_ADDRESS_TAGS: string
  XDAI_REGISTRY_TOKENS: string
  XDAI_REGISTRY_DOMAINS: string
  XDAI_REGISTRY_ATQ: string
  DUNE_API_KEY: string
  DUNE_BASE_URL: string
  DUNE_QUERY_PERFORMANCE: string
  DUNE_POLL_INTERVAL_SECONDS: string
  DUNE_MAX_POLLS: string
  DUNE_HTTP_MAX_RETRIES: string
  DUNE_HTTP_RETRY_BASE_MS: string
  DUNE_STATUS_LOG_EVERY_POLLS: string
  WALLET_PRIVATE_KEY: string
  PNK: string
  STIPEND: string
  MAX_REWARD: string
  REWARD_FORMULA_ADDRESS_TAGS: string
  REWARD_FORMULA_TOKENS: string
  REWARD_FORMULA_DOMAINS: string
  REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS: string
  REWARD_REDISTRIBUTE_CAPPED_TOKENS: string
  REWARD_REDISTRIBUTE_CAPPED_DOMAINS: string
  SOLANA_TX_DIVIDER: string
  SOLANA_TX_LOOKBACK_DAYS: string
  REMOVAL_REWARD_POOL_ADDRESS_TAGS: string
  REMOVAL_REWARD_POOL_TOKENS: string
  REMOVAL_REWARD_POOL_DOMAINS: string
  REMOVAL_MAX_PER_REMOVAL_ADDRESS_TAGS: string
  REMOVAL_MAX_PER_REMOVAL_TOKENS: string
  REMOVAL_MAX_PER_REMOVAL_DOMAINS: string
  REWARD_POOL_ATQ_SUBMISSIONS: string
  MAX_PER_ATQ_SUBMISSION: string
  REWARD_POOL_ATQ_REMOVALS: string
  MAX_PER_ATQ_REMOVAL: string
  TX_NETWORK_ID: string
  FILES_DIR: string
}

const getSanitizedConfig = (config: unknown): Config => {
  for (const [key, value] of Object.entries(
    config as { [value: string]: string | undefined }
  )) {
    if (value === undefined) {
      throw new Error(`Missing key ${key} in config.env`)
    }
  }
  return config as Config
}

const sanitizedConfig = getSanitizedConfig(process.env)

export default sanitizedConfig
