interface Config {
  XDAI_GTCR_SUBGRAPH_URL: string
  XDAI_REGISTRY_ADDRESS_TAGS: string
  XDAI_REGISTRY_TOKENS: string
  XDAI_REGISTRY_DOMAINS: string
  NODE_ENV: string
  MAINNET_RPC: string
  BSC_RPC: string
  GNOSIS_RPC: string
  POLYGON_RPC: string
  WALLET_PRIVATE_KEY: string
  PNK: string
  TEST_PNK: string
  STIPEND: string
  TX_NETWORK_ID: string
  TX_TEST_PROVIDER: string
  TX_TEST_NETWORK_ID: string
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
