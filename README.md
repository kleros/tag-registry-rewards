# Tag Registry Rewards 2.0

Unified reward pipeline combining:

- tag fetching from `tag-registry-rewards`
- transaction counts from Envio HyperSync (EVM) and Solana JSON-RPC, both free
  (Dune is still available as an option, see [Transaction counts](#transaction-counts))

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

- `ENVIO_API_TOKEN` (EVM tx counts; free token at https://envio.dev/app/api-tokens)
- `SOLANA_RPC_URLS` (optional; comma-separated Solana RPC URLs, defaults to the
  public endpoint; add free Helius and Alchemy URLs, see [Transaction counts](#transaction-counts))
- `REWARD_FORMULA_ADDRESS_TAGS` (expression formula for Address Tags registry)
- `REWARD_FORMULA_TOKENS` (expression formula for Tokens registry)
- `REWARD_FORMULA_DOMAINS` (expression formula for Domains registry)
- `REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_TOKENS` (`true` or `false`)
- `REWARD_REDISTRIBUTE_CAPPED_DOMAINS` (`true` or `false`)
- `SOLANA_TX_DIVIDER` (number `>= 1`; applied in `generate` before formula evaluation)
- `SOLANA_TX_LOOKBACK_DAYS` (`0`/empty for all-time; a positive N-day window is only supported by the Dune provider)
- wallet settings are required only for `send`
- all tx-count settings, including the optional Dune ones, are listed commented
  out in `.env.example`

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

## Transaction counts

`fetch` weights rewards by each contract's **all-time count of successful
transactions sent to it**, counted up to the run. The counts are free:

| | EVM (14 chains) | Solana |
|---|---|---|
| Provider (default) | Envio HyperSync, `EVM_TX_PROVIDER=hypersync` | JSON-RPC, `SOLANA_TX_PROVIDER=rpc` |
| What is counted | top-level txs with `to` = address and `status = 1` (pre-Byzantium Ethereum, which has no status: `gasUsed < gas` or the receipt has logs, see below); on HyperEVM, user-signed txs only (see below) | signatures from `getSignaturesForAddress` with `err == null`; histories above 1.5M signatures estimated by sampling (below) |
| Key | `ENVIO_API_TOKEN` (free, required) | none; `SOLANA_RPC_URLS` to add free Helius/Alchemy URLs |
| Holders (Tokens) | — | distinct owners of open token accounts, any balance (Jupiter's count when it already shows ≥ 5,000); an entry that is not a token mint gets 0 |

Ethereum receipts before Byzantium (block 4,370,000, October 2017) have no
status. A failed transaction then burnt all its gas and kept no logs, so one
counts as successful if it left gas unused or emitted a log. A success that used
exactly its gas limit and emitted nothing cannot be told apart from a failure
without traces (a paid HyperSync add-on) and is not counted. Dune does not
document how it marked these transactions, so whether the old query counted
them is unknown; no past payout included a contract that old.

These match the Dune queries used until September 2026 (`EVM_TX_PROVIDER=dune`
and `SOLANA_TX_PROVIDER=dune` still work with a paid Dune plan and
`DUNE_API_KEY`; each lane picks its provider on its own, and the Dune lanes keep
no cache, so `--max-minutes` and `prefetch` do not apply to them), with two
exceptions: HyperEVM system transactions are left out (below), and very large
Solana addresses outside the Tokens registry are estimated. Neither API can
return a count, so every matching transaction or signature is streamed and
counted. That takes time:

- **EVM:** about 0.7 billion matching transactions in September 2026. A free
  token allows 15 requests per minute (its rate-limit headers), shared by all
  chains, whatever the page size, so each request asks for up to
  `HYPERSYNC_MAX_ROWS_PER_REQUEST` rows (default 500,000; without it the server
  stops at ~5,500). `verify-counts` measures rows per request and prints the
  estimate. Requests are paced at `HYPERSYNC_REQUESTS_PER_MINUTE` (default 14).
- **Solana:** about 740 million signatures for September 2026's 53 counted
  token mints, 1,000 per call. Measured on 2026-10-06/07, Helius Free sustains
  ~5–6 `getSignaturesForAddress` calls/s, an Alchemy key ~0.5 (free) or ~7
  (the paid plan tried) before its compute-units-per-second limit, and the
  public RPC ~0.8. Listing all of it would take a day and a half, hence the
  sampling below. No free source returns a count: SQD's keyless portal does
  filter Solana transactions by account (`mentionsAccount`) but covers only
  ~500 recent slots per request and throttles, and the other keyless RPCs tried
  either keep no history or need a key. In `SOLANA_COUNT_MODE=exact`, addresses
  outside the Tokens registry above `SOLANA_ESTIMATE_ABOVE` signatures (default
  50M, e.g. Jupiter's program) are estimated with an older, less reliable probe
  estimator and flagged as `estimated` in the manifest.

**Run time and Solana sampling.** Neither lane can ask for a count, so the
work grows with the number of transactions. EVM costs one HyperSync request per
~435,000 transactions; Solana costs one call per 1,000 signatures. Counted from
scratch, September 2026 needed ~690M EVM transactions (1 h 47 min on the free
HyperSync tier) and ~740M Solana signatures, which take ~34 h to list on the
free keys (~32 h with a paid Alchemy key that allows ~7 calls/s).

So by default (`SOLANA_COUNT_MODE=auto`) Solana lists a history exactly only
when it is small (below `SOLANA_EXACT_BELOW`, 1.5M signatures) and estimates
larger ones by stratified sampling: a first pass maps the density of the
history (a quick 20-point pass first, so a range far below the threshold is
listed without the full map), it is cut into strata of equal mapped mass, and one window per stratum,
placed uniformly at random, is counted exactly and scaled up. The estimate is
unbiased; replayed on complete histories and checked against exact counts of 16
September mints, its typical error was ~10% per mint (worst ±25%) for ~1.5–2k
calls instead of up to ~120k. Most mints that large are capped at 500 PNK, so
the payout effect is small: two September runs moved the total by +570 and +732
PNK against the Dune payout (Tokens only) and no recipient by more than 1%.
Sampled counts are flagged `sampled` in the manifest. `SOLANA_COUNT_MODE=exact`
lists everything instead (a day or more for a busy month).

A cold September in auto mode took 2 h 29 min (Solana ~85k calls at ~10
calls/s on Helius Free + a paid Alchemy key + the public RPC; EVM 1 h 47 min in
parallel). Counts are cached, so addresses seen before only top up. To go
faster, raise the Solana calls per second (e.g. the Alchemy plan's compute
units per second) or the HyperSync tier.

`--max-minutes N` bounds the counting: both lanes stop before their next
request once N minutes have passed since counting started (fetching and
filtering the tags before it is not included), with progress saved; `fetch` and
`all` write nothing (exit code 2) and the next run continues. `yarn start --mode prefetch` counts the running month's tags so far
into the cache, so a month-end run after a prefetch only tops up.

Both run in parallel. Long histories are split across parallel requests
automatically. A Solana count ends only on an empty page, asked of a second URL
when there is one (so do the newest page and the search for where a history
starts before sampling), and every page is checked against its cursor: the providers
run different archives, and a short page can come back while older history
exists. A split starts below a transaction that need not involve the address;
an empty page there is trusted only from a URL that can find that transaction
(`getSignatureStatuses`), because older nodes answer `[]` for a cursor they do
not know instead of an error. Holder scans (`getProgramAccounts`) go to the public RPC first, the one
endpoint verified for them, and to the other URLs only if it refuses, so keep
`https://api.mainnet-beta.solana.com` in `SOLANA_RPC_URLS`. A URL that rejects
its key (HTTP 401/402/403) stops the run at start. Later in a run, a 403 or 410
takes only that method off the URL (plans and the public RPC refuse single
methods); a second refused method, or a 401/402, disables the URL.

**HyperEVM (999) counts user-signed transactions only.** HyperCore credits
arrive on HyperEVM as system transactions (gas price 0, sent from `0x2222…2222`
for HYPE or from `0x20…` addresses for linked spot tokens) that the block's
transaction root does not cover, and HyperSync, like the official RPC, does not
return them. This mainly affects contracts linked to HyperCore: in September
2026 such credits were 77% of the successful transactions sent to Circle's
CoreDepositWallet and 72% of those sent to UPUMP. Explorers such as
hyperevmscan.io include them, so their totals are higher. The manifest repeats
this note for chain 999. Whether HyperCore credits should count is a program
decision.

**Cache and resume.** Counts are stored per address with the block or signature
they cover, in `~/.cache/tag-registry-rewards/tx-counts` (`TX_COUNT_CACHE_DIR`),
outside `files/`. An interrupted fetch resumes where it stopped, still counting
up to the new run's tip (an address that was being sampled is sampled again), and later months only scan what is new for addresses
seen before. `TX_COUNT_CACHE=off` recounts everything from scratch. The fetch
manifest records the provider,
cutoff block per chain, cache path and, for Solana, each address's method
(`exact`/`estimated`) and holder source.

**Check before paying.** Run this after setting the keys; it compares against
values counted independently and measures speed:

```bash
yarn start --mode verify-counts
```

- PNK on Ethereum through block 26,095,339 must give 63,785 successful
  (76,189 including failed)
- HyperSync must have every chain's history from block 0
- every Solana URL must serve history back to 2021, find a 2021 transaction by
  signature (`getSignatureStatuses` with `searchTransactionHistory`), and count
  CIGR up to 2026-10-01 exactly (45,869 successful / 51,840 signatures) on its own
- every Solana URL should refuse an unknown `before` cursor (an empty answer is
  reported as INFO, since fetch then looks the cursor up; a page fails), and with
  several URLs all of them must return the same 1,000-signature USDC window in
  the same order
- HTC on Solana up to the March 2026 run must give 125,037 successful / 172,105
  signatures
- HyperSync must return no HyperEVM system transactions in a 300-block sample
  where SQD lists 75
- The DAO before Byzantium must give 160,073 successful if HyperSync carries a
  status for those receipts, or exactly 160,065 with the gas-or-logs rule if it
  does not (8 successes used their whole gas limit and emitted no log)
- it also prints a rows-per-request throughput sample, with the projected EVM
  run time

## Quick start (last month)

When `--start` and `--end` are omitted, `fetch` and `filter-check` automatically calculate the previous calendar month. So to generate rewards for the most recent period:

```bash
# Step 1: fetch tags + enrich (auto-calculates last month; ~2–2.5 h from scratch)
yarn start --mode fetch

# Step 2: generate reward allocations from the latest fetch
yarn start --mode generate

# Step 3: send transactions on-chain
yarn start --mode send --rewards <transactions-file>.json
```

## Modes

Run all commands from this folder:

```bash
yarn start --mode <fetch|prefetch|filter-check|removals|generate|document|all|send|verify-counts> [args]
```

### 1) Fetch

```bash
yarn start --mode fetch [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

`--start` and `--end` are optional. When omitted they default to the previous calendar month (1st of last month to 1st of current month).

What it does:

- fetches from Address Tags, Tokens, Domains registries
- drops Domains entries whose chain + address is registered in the Tokens registry
- applies exclusion filters:
  - chain not configured for rewards
  - Address Tags: skip EOA (`getCode == 0x`)
  - Address Tags: skip EIP-1167 proxy when implementation has code
  - Address Tags: skip ERC-721 (`supportsInterface(0x80ac58cd)`)
  - Solana Address Tags skip bytecode checks
- enriches EVM and Solana rows (see [Transaction counts](#transaction-counts)):
  - `txn count`
  - Solana holders (tokens only)
- filters out Solana token rows with holders `< 5000`
- stops with an error, writing nothing, if any count is missing: counts drive
  the payout split, so they never default to 0. Rerun to resume.

Files written under `files/`:

- `<runId>_full.csv` (audit output)
- `<runId>_full.json` (same data as JSON)
- `<runId>_generate_input.json` (combined input for `generate`)
- `<runId>_generate_tags.json` (tags file, compatibility)
- `<runId>_generate_gas.json` (tx counts file, compatibility)
- `<runId>_fetch_manifest.json`
- `latest_fetch_manifest.json`

### 1b) Prefetch

```bash
yarn start --mode prefetch [--max-minutes N] [--period YYYY-MM | --start YYYY-MM-DD --end YYYY-MM-DD]
```

Counts the transactions of every tag registered so far in the running month
(by default) into the tx-count cache, exactly as `fetch` would, and writes no
files. The month-end `fetch` then only tops the cached counts up. Each run
resumes where the last one stopped (an address that was being sampled is
sampled again); at `--max-minutes` both lanes stop before
their next request with everything counted so far saved, and the run exits 0.
It needs the cache and the free providers (not `TX_COUNT_CACHE=off` or the Dune
providers).

### 2) Filter-check

```bash
yarn start --mode filter-check [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

`--start` and `--end` are optional (same default as fetch).

What it does:

- runs only exclusion checks (no tx counts, no Solana holders)
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
  - no tx-count enrichment and no tx-weighting (removals are not weighted by tx count)
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
only, ~1 min, no tx counts):

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
