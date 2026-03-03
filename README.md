# Tag Registry Rewards 2.0

Unified reward pipeline combining:

- tag fetching from `tag-registry-rewards`
- EVM enrichment logic via Dune SQL
- Solana enrichment logic from `solana_only`

The `generate` and `send` steps stay compatible with the old reward flow.

## Install

```bash
cp .env.example .env
yarn
```

If `yarn install` fails with OpenSSL/cipher errors on Windows, use Node 18 + npm:

```bash
nvm install 18.20.5
nvm use 18.20.5
npm install
npx tsc --noEmit
```

Fill `.env` values:

- `DUNE_API_KEY` (required for Solana and EVM enrichment)
- `ETHERSCAN_API_KEY` (optional, currently unused for EVM tx count)
- `REWARD_FORMULA_ADDRESS_TAGS` (expression formula)
- `REWARD_FORMULA_TOKENS` (expression formula)
- `REWARD_FORMULA_DOMAINS` (expression formula)
- `REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_TOKENS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_DOMAINS` (`true` or `false`)
- `SOLANA_TX_DIVIDER` (number `>= 1`; applied in `generate` before formula evaluation)
- wallet settings are required only for `send`
- Optional Dune stability tuning:
  - `DUNE_HTTP_MAX_RETRIES`
  - `DUNE_HTTP_RETRY_BASE_MS`
  - `DUNE_STATUS_LOG_EVERY_POLLS`

Formula syntax:

- supported operators: `+`, `-`, `*`, `/`, parentheses
- supported function: `sqrt(...)`
- supported variables:
  - `reward_pool`
  - `total_submissions`
  - `token_tx` (alias of `txns_with_contract`)
  - `txns_with_contract`
  - `total_txns_with_all_contracts`
  - `sum_sqrt_total_txns_with_all_contracts`
- default formula (same logic as before):
  - `(reward_pool/(2*total_submissions)) + ((reward_pool*txns_with_contract)/(2*total_txns_with_all_contracts))`
- capped reward redistribution toggle:
  - `true`: current behavior, recursively redistributes leftover stipend until no entry is above `MAX_REWARD`
  - `false`: one-pass cap only (`min(formula_reward, MAX_REWARD)`), no recursive redistribution
- Solana reducer:
  - effective `txCount` for Solana entries is `floor(txCount / SOLANA_TX_DIVIDER)` before any formula math
  - non-Solana entries are not changed

## Modes

Run all commands from this folder:

```bash
yarn start --mode <fetch|filter-check|generate|send> [args]
```

### 1) Fetch

```bash
yarn start --mode fetch --start YYYY-MM-DD --end YYYY-MM-DD
```

What it does:

- fetches from Address Tags, Tokens, Domains registries
- applies only the Address Tags extra contract checks:
  - skip EOA (`getCode == 0x`)
  - skip EIP-1167 proxy when implementation has code
  - skip ERC-721 (`supportsInterface(0x80ac58cd)`)
  - keep Solana Address Tags without bytecode checks
  - skip when chain config is missing
- enriches EVM and Solana rows:
  - `txn count`
  - Solana holders (tokens only)
- filters out Solana token rows with holders `< 5000`

Files written under `files/`:

- `<runId>_full.csv` (audit output)
- `<runId>_full.json` (same data as JSON)
- `<runId>_generate_input.json` (combined input for `generate`)
- `<runId>_generate_tags.json` (tags file, compatibility)
- `<runId>_generate_gas.json` (tx counts file, compatibility)
- `<runId>_fetch_manifest.json`
- `latest_fetch_manifest.json`

### 2) Filter-check

```bash
yarn start --mode filter-check --start YYYY-MM-DD --end YYYY-MM-DD
```

What it does:

- runs only exclusion checks (no Dune tx-count, no Helius/Solana holders)
- reports exclusions from:
  - chain not configured for rewards
  - Address Tags: not a contract (`getCode == 0x`)
  - Address Tags: EIP-1167 proxy
  - Address Tags: ERC-721 contract
- writes a standalone CSV report and does not touch fetch manifest files

File written under `files/`:

- `<runId>_filter_check.csv` (detail rows + summary rows with totals by reason)

### 3) Generate

```bash
yarn start --mode generate
```

By default it reads `files/latest_fetch_manifest.json` and uses that run’s:

- `generate_tags`
- `generate_gas`

You can still override explicitly:

```bash
yarn start --mode generate --tags <file>.json --gas <file>.json
```

Outputs:

- rewards CSV
- transaction JSON
- transaction CSV

### 4) Send

```bash
yarn start --mode send --rewards <file>.json
```

Uses the generated transactions JSON and sends transfers exactly as before.
