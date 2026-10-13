# September 2026 golden fixture

The published payout of the September 2026 period, used as a regression test
(`test/integration/golden-september.test.ts`): rerunning `generate` and
`document` on these inputs, with the settings in `config.json` (the
`.env.example` values of that run), must reproduce the published amounts to
the wei.

| File | Source (`files/` of the run of 2026-10-02) |
|---|---|
| `generate_tags.json.gz` | `1790985006963_generate_tags.json` (1,088 tags, minified) |
| `generate_gas.json.gz` | `1790985006963_generate_gas.json` (tx counts, Dune) |
| `transactions.expected.json` | `1790985007241.json`, the submissions send file |
| `expected-hashes.json` | sha256 (base64) of `1790985007241_rewards.json`, `.csv`, `_tx.csv` |
| `removals.json.gz`, `atq.json.gz` | `1790985008041_removals.json`, `1790985008041_atq.json` |
| `removals_transactions.json`, `atq_transactions.json` | the removals and ATQ send files |
| `curate-rewards-2026-09.expected.json.gz` | the snapshot published on IPFS (`QmQDj5WVMLvGEQ9hy1Khh1HJ1Tv677ZDwBAceYvio2T3Mn`), without `generatedAt` |

The three send files were paid on Gnosis on 2026-10-06 by
`0xbe7ee23877d530b8a17971cfda7b5925b57e87b1` (12 transfers, 301,298.63 PNK).

Only change these files when a payout rule changes on purpose, and say so in
the commit.
