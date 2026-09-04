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
- `REWARD_FORMULA_ADDRESS_TAGS` (expression formula for Address Tags registry)
- `REWARD_FORMULA_TOKENS` (expression formula for Tokens registry)
- `REWARD_FORMULA_DOMAINS` (expression formula for Domains registry)
- `REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_TOKENS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_DOMAINS` (`true` or `false`)
- `SOLANA_TX_DIVIDER` (number `>= 1`; applied in `generate` before formula evaluation)
- `SOLANA_TX_LOOKBACK_DAYS` (positive number for N-day lookback window, or `0`/empty for all-time)
- `EVM_TX_LOOKBACK_DAYS` (same, for EVM chains; all-time scans of ethereum/base/arbitrum exceed the Dune free tier's execution cap and abort the run)
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
- each registry has its own formula and redistribution toggle
- capped reward redistribution toggle (per registry):
  - `true`: current behavior, recursively redistributes leftover stipend until no entry is above `MAX_REWARD`
  - `false`: one-pass cap only (`min(formula_reward, MAX_REWARD)`), no recursive redistribution
- Solana reducer:
  - effective `txCount` for Solana entries is `floor(txCount / SOLANA_TX_DIVIDER)` before any formula math
  - non-Solana entries are not changed

## Quick start (last month)

When `--start` and `--end` are omitted, `fetch` and `filter-check` automatically calculate the previous calendar month. So to generate rewards for the most recent period:

```bash
# Step 1: fetch tags + enrich (auto-calculates last month)
yarn start --mode fetch

# Step 2: generate reward allocations from the latest fetch
yarn start --mode generate

# Step 3: send transactions on-chain
yarn start --mode send --rewards <transactions-file>.json
```

## Modes

Run all commands from this folder:

```bash
yarn start --mode <fetch|filter-check|removals|generate|document|all|send> [args]
```

### 1) Fetch

```bash
yarn start --mode fetch [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

`--start` and `--end` are optional. When omitted they default to the previous calendar month (1st of last month to 1st of current month).

What it does:

- fetches from Address Tags, Tokens, Domains registries
- filters out tokens that also appear in the Address Tags registry
- applies exclusion filters:
  - chain not configured for rewards
  - Address Tags: skip EOA (`getCode == 0x`)
  - Address Tags: skip EIP-1167 proxy when implementation has code
  - Address Tags: skip ERC-721 (`supportsInterface(0x80ac58cd)`)
  - Solana Address Tags skip bytecode checks
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
yarn start --mode filter-check [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

`--start` and `--end` are optional (same default as fetch).

What it does:

- runs only exclusion checks (no Dune tx-count, no Solana holders)
- reports exclusions from:
  - chain not configured for rewards
  - Address Tags: not a contract (`getCode == 0x`)
  - Address Tags: EIP-1167 proxy
  - Address Tags: ERC-721 contract
  - tokens appearing in Address Tags registry
- writes a standalone CSV report and does not touch fetch manifest files

File written under `files/`:

- `<runId>_filter_check.csv` (detail rows + summary rows with totals by reason)

### 3) Removals + ATQ

```bash
yarn start --mode removals [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

`--start` and `--end` are optional (same default as fetch).

What it does:

- detects items **removed** within the period (status `Absent`, `numberOfRequests > 1`, whose latest `ClearingRequested` resolved in range) across Address Tags, Tokens, Domains
- rewards the **remover** (the requester of the winning removal) with a flat, capped, per-registry amount:
  - `min(REMOVAL_REWARD_POOL_<registry> / removals_in_period, REMOVAL_MAX_PER_REMOVAL_<registry>)`
  - one-pass cap, no recursive redistribution (unlike submissions)
  - no Dune enrichment and no tx-weighting (removals are not weighted by tx count)
- deduplicates per registry + tagged address + chain (keeps the latest removal)
- also **rewards ATQ** activity for the ATQ registry (`XDAI_REGISTRY_ATQ`), with registrations and removals computed **independently** (each kind has its own pool and cap):
  - registrations: `min(REWARD_POOL_ATQ_SUBMISSIONS / registrations_in_period, MAX_PER_ATQ_SUBMISSION)` — official policy: 60,000 PNK pool, capped at 3,000 PNK per submission
  - removals: `min(REWARD_POOL_ATQ_REMOVALS / removals_in_period, MAX_PER_ATQ_REMOVAL)` — official policy: 6,500 PNK pool, capped at 500 PNK per removal
  - rewards the ATQ requester (submitter for registrations, remover for removals)
  - produces its own send file, so removals and ATQ are disbursed separately from submissions

> ⚠️ **Detection reads *current* statuses — run soon after the period ends.**
> Removals are found by looking at items whose status is `Absent` (ATQ
> registrations: `Registered`) *at run time*. An item removed in the period
> but re-registered before the run is missed — and because rewards are
> pool-based, one missed removal changes *everyone's* amounts in that
> registry. Re-running a few days later (e.g. for exclusions) is fine;
> re-running a months-old period is lossy and will not reproduce the original
> amounts. Also note an ATQ item registered **and** removed within the same
> period only earns the removal reward.

Files written under `files/`:

- `<runId>_removals.csv` (detail: submitter, registry, chain, address, removed at, reward)
- `<runId>_removals.json` (full reward data)
- `<runId>_removals_transactions.json` (removals, aggregated per recipient — **compatible with `--mode send`**)
- `<runId>_removals_transactions.csv`
- `<runId>_atq.json` (full ATQ reward data)
- `<runId>_atq_transactions.json` (ATQ, aggregated per recipient — **compatible with `--mode send`**)
- `<runId>_atq_transactions.csv`
- `<runId>_atq_registered.csv`, `<runId>_atq_absent.csv` (reports, now with the `Rewarded` amount filled in)
- `<runId>_removals_manifest.json`, `latest_removals_manifest.json`

Both transaction files are disbursed the same way as submissions:

```bash
yarn start --mode send --rewards <runId>_removals_transactions.json
yarn start --mode send --rewards <runId>_atq_transactions.json
```

### 4) Generate

```bash
yarn start --mode generate
```

By default it reads `files/latest_fetch_manifest.json` and uses that run's:

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

### 5) Send

```bash
yarn start --mode send --rewards <file>.json
```

Uses the generated transactions JSON and sends transfers exactly as before. Run
it once per transactions file (submissions and removals are separate files).

### 6) Document (publish to IPFS)

```bash
yarn start --mode document [--period YYYY-MM]
yarn start --mode document --submissions <file>.json --removals <file>.json --period YYYY-MM
```

Borrowing the structure of the Kleros staking-rewards flow (but without any
merkle tree or claim contract — rewards are disbursed directly by `send`), this
merges the submission, removal, and ATQ rewards of a period into one structured
JSON and publishes it so recipients can look their rewards up.

What it does:

- reads the latest `generate` rewards (`latest_generate_manifest.json`) and the
  latest `removals` + ATQ rewards (`latest_removals_manifest.json`) unless
  `--submissions` / `--removals` / `--atq` are given
- merges them per recipient (case-insensitive) into `curate-rewards/v1`:
  `{ period, totals, recipients: { "0x…": { total, submissions[], removals[], atq[] } } }`
- uploads the JSON to IPFS via Filebase when `FILEBASE_TOKEN` is set
  (→ `https://cdn.kleros.link/ipfs/<cid>`); otherwise it just writes it locally
- upserts the period into `curate-rewards-index.json` (newest first)

Outputs are written to `files/` (gitignored): `curate-rewards-<period>.json` and
`curate-rewards-index.json`.

Optional env (`.env`): `FILEBASE_TOKEN`, `IPFS_GATEWAY` (defaults to
`https://cdn.kleros.link/ipfs`).

Notes on publishing:

- **Merge, never overwrite.** `files/` is gitignored, so on a fresh machine
  `curate-rewards-index.json` only contains the periods generated locally.
  When updating a frontend (gtcr `public/data/`, rewards-dashboard
  `src/assets/curate-rewards-index.json`), merge the new period's entry/URL
  into the deployed index — copying the local file wholesale would erase all
  historical months.
- `curate-rewards-index.urls.json` is emitted alongside the rich index: a plain
  array of gateway URLs, the format the rewards dashboard bundles.
- If `FILEBASE_TOKEN` is set and the upload fails, `document` now exits
  non-zero instead of silently writing a `cid: null` index entry. Without a
  token it still writes the local JSON only (dev flow).
- Per-event rewards use floor division of the pool, so a period's totals can
  undershoot the configured pools by a few wei. This is expected: the snapshot
  stays self-consistent because totals are summed from the actual line amounts.
- If `document` fails after writing the local snapshot (e.g. the upload
  errors), the index is NOT updated — the local snapshot and index disagree
  until you re-run `document` for that period, which is safe and idempotent.

## Exclusions: fixing rewards after they were generated

Scenario: the monthly run is done — jsons, csvs, even the IPFS record — and
**then** you find out two of the rewarded tags shouldn't count (e.g. they were
already tagged on the explorer). You do **not** need to refetch anything, and
you must **not** hand-edit the generated jsons:

> ⚠️ Rewards are **pool-based**. Deleting 2 rows from a rewards/transactions
> file leaves everyone else's amounts wrong — the excluded share must be
> **redistributed** by re-running the (purely local, ~1s) pool math.

### The fix, step by step

**1. Record the exclusions** in `exclusions.json` at the repo root (committed,
so every exclusion has an audit trail — copy `exclusions.example.json` to start):

```json
[
  {
    "tagAddress": "0x971Ff919f91fFd1Faa847e1a773e8a547e3eFc82",
    "chain": "43114",
    "registry": "addressTags",
    "scope": "submissions",
    "reason": "already tagged on snowscan, found manually 2026-07-16"
  }
]
```

Matching rules (everything is case-insensitive):

- `tagAddress` — the tagged address; add `chain` (CAIP reference: `"1"`,
  `"8453"`, Solana genesis hash…) and/or `registry`
  (`addressTags|tokens|domains`) to narrow it. Omitted = matches all.
- `itemID` — alternative precise matcher: the Curate item id (bare, or the
  `<itemID>@<registry>` form). **Required** for ATQ entries (ATQ rows have no
  tagged address).
- `scope` — `submissions` | `removals` | `atq` | `all` (default `all`).
  A tag wrongly rewarded as a *submission* usually shouldn't lose its future
  *removal* reward — scope it to `submissions`.
- `reason` — mandatory; printed every time the entry drops a reward.

A malformed file **aborts the run** (money is involved), and an entry that
matches nothing prints a `WARNING` so typos can't silently do nothing.

**2. Recompute the submissions** — offline, seconds, using the inputs the
original fetch already saved (`files/<runId>_generate_tags.json` + `_generate_gas.json`):

```bash
yarn start --mode generate   # uses files/latest_fetch_manifest.json
# or pin the run explicitly:
yarn start --mode generate --tags <runId>_generate_tags.json --gas <runId>_generate_gas.json
```

Look for the log lines:

```
[exclusions] Loaded 1 entrie(s) from exclusions.json
[exclusions] Dropping submissions 0x971F...fC82 (chain 43114) [addressTags] — already tagged on snowscan...
[exclusions] 1 submission(s) excluded, 621 remain.
```

This rewrites the rewards json, the transactions json/csv, and
`latest_generate_manifest.json`. Registry totals stay pool-exact; the excluded
share flows to the remaining submitters.

**3. Only if a *removal* or *ATQ* reward was wrong:** re-run removals (subgraph
only, ~1 min, no Dune):

```bash
yarn start --mode removals --start YYYY-MM-01 --end YYYY-MM+1-01
```

Exclusions are applied before dedupe, so excluding a bogus latest removal lets
an earlier legitimate removal of the same item count instead. Re-run promptly:
removal detection reads *current* statuses (see the caveat in "Removals +
ATQ"), so re-running a months-old period can miss items whose status has
since changed and shift everyone's pool-based amounts.

**4. Republish the period record** (replaces the period's entry in the index):

```bash
yarn start --mode document --period YYYY-MM
```

Then **merge the refreshed period's entry** (and snapshot, unless on IPFS) into
the frontend's existing index — see "Notes on publishing" above: the local
index only holds locally-generated periods, so copying it wholesale would
erase the historical months.

**5. Verify before sending.** Compare old vs new transactions csv — only the
affected registry's recipients should have moved. Then `--mode send` the new
transactions file.

> ⚠️ Do all of this **before** `--mode send`. Amounts redistribute, so if the
> old rewards were already paid on-chain there is no automated diff/claw-back —
> you'd have to compute and settle the differences manually.

The list is applied on **every** future `generate`/`removals` run (including
`--mode all`), so exclusions survive refetches. Point `EXCLUSIONS_FILE` in
`.env` somewhere else to override the default `./exclusions.json`.

## Public rewards page

The read-only page that shows recipients their submission/removal/ATQ rewards
lives in the **gtcr** frontend (`gtcr/public/curate-rewards.html`), served at
`/curate-rewards.html` — the Curate analog of court's `staking-rewards.html`.

This repo only produces the data. To publish a period, **merge the new
period's entry** from `files/curate-rewards-index.json` (and, unless the
snapshot is on IPFS, its `curate-rewards-<period>.json` file) into the gtcr
frontend's existing `public/data/curate-rewards-index.json` — never overwrite
the deployed index wholesale (see "Notes on publishing"). The page loads
`./data/curate-rewards-index.json` by default (override with `?index=<url>`);
when an index entry has an IPFS `url` the snapshot is fetched from
`cdn.kleros.link`, otherwise from `./data/`. The rewards dashboard instead
bundles a plain URL array — append the new snapshot's URL there
(`curate-rewards-index.urls.json` has that shape, regenerated on every
document run; it can go stale if you hand-edit the rich index).

## Full monthly flow

Everything except the on-chain disbursement can run in one command:

```bash
yarn start --mode all --period YYYY-MM
# = fetch -> generate -> removals -> document (in order)
```

`all` deliberately does **not** send. Review the amounts, then disburse
manually. Note the run ids differ per step: the submissions transactions file
is named with the **generate** run's timestamp, while the removals and ATQ
files share the **removals** run's timestamp (check
`latest_generate_manifest.json` / `latest_removals_manifest.json` for the
exact filenames):

```bash
yarn start --mode send --rewards <generateRunId>.json                       # pay submissions
yarn start --mode send --rewards <removalsRunId>_removals_transactions.json # pay removals
yarn start --mode send --rewards <removalsRunId>_atq_transactions.json      # pay ATQ
```

Or run each step by hand:

```bash
yarn start --mode fetch        # submissions: tags + enrich
yarn start --mode generate     # submissions: reward allocations
yarn start --mode removals     # removals + ATQ rewards + reports
yarn start --mode document --period YYYY-MM   # publish the combined record to IPFS
```
