interface Config {
  XDAI_GTCR_SUBGRAPH_URL: string
  XDAI_REGISTRY_ADDRESS_TAGS: string
  XDAI_REGISTRY_TOKENS: string
  XDAI_REGISTRY_DOMAINS: string
  NODE_ENV: string
  WALLET_PRIVATE_KEY: string
  PNK: string
  STIPEND: string
  MAX_REWARD: string
  TX_NETWORK_ID: string
  FILES_DIR: string
  HELIUS_SOLANA_API_KEY: string
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
