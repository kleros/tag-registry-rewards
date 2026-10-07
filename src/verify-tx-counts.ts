import { randomBytes } from "crypto"
import { utils } from "ethers"
import { chains } from "./utils/chains"
import {
  countEvmTxsWithHypersync,
  countTransactionsFrom,
  firstIndexedBlock,
  getHypersyncHeight,
} from "./utils/hypersync-enrichment"
import { errorMessage as message } from "./utils/runtime-helpers"
import { maskRpcUrl, SolanaRpcError, SolanaRpcPool } from "./utils/solana-rpc"
import {
  checkHolders,
  countSignaturesExact,
  defaultSolanaRpcPool,
  findAnchor,
} from "./utils/solana-rpc-enrichment"

// `--mode verify-counts`: checks the free providers against known answers
// before a real fetch. Golden values were counted independently (full
// transaction lists) on 2026-10-01/02.

type Status = "PASS" | "FAIL" | "SKIP" | "INFO"

interface CheckResult {
  check: string
  status: Status
  detail: string
}

// PNK on Ethereum through block 26,095,339. Routescan's txlist (every page)
// has 63,783 / 76,187, but it counts the creation tx (to = null on-chain, so
// neither Dune nor HyperSync matches it) and misses three successful transfers
// in block 18,239,284 (0x10bef5df…, 0xb576f08e…, 0xc457dc42…), each confirmed
// on an Ethereum node (receipt status 1): 63,783 - 1 + 3 and 76,187 - 1 + 3.
const PNK = "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d"
const PNK_TO_BLOCK_EXCLUSIVE = 26095340
const PNK_SUCCESSFUL = 63785
const PNK_ALL = 76189
// The DAO, active before Byzantium (block 4,370,000), when receipts had no
// status. Routescan txlist (every page, creation tx excluded), 2026-10-02:
// 160,073 of 172,544 transactions succeeded by execution traces. Without a
// status, the gas-or-logs rule gives 139,254 that left gas unused plus 20,811
// of the 20,819 full-gas successes, whose receipts have logs (each checked).
const THE_DAO = "0xbb9bc244d798123fde783fcc1c72d3bb8c189413"
const THE_DAO_CALLS = 172544
const THE_DAO_SUCCESSFUL = 160073
const THE_DAO_GAS_OR_LOGS = 160065
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
// HTC on Solana up to blockTime 1772814643 (the March 2026 run; exact page-through).
const HTC = "HTCiQqiJa4e2L7aB5heTVgb2FYJyWDr6XdgsHwr3MpLR"
const HTC_CUTOFF = 1772814643
const HTC_SUCCESSFUL = 125037
const HTC_ALL = 172105
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
// CIGR up to 2026-10-01T00:00Z, counted on the public RPC both sequentially and
// split (identical). Checked per URL, since providers could index differently.
const CIGR = "3P6WB3hifQ9Z38Ja5qNuaETkgstJUWmP6vf58aYupump"
const CIGR_CUTOFF = 1790812800
const CIGR_SUCCESSFUL = 45869
const CIGR_ALL = 51840
// A busy USDC window (many signatures per slot) that every URL must return
// identically, order within each slot included: fetch mixes URLs in one count.
const WINDOW_SLOT = 400000000
// HyperCore system senders (HYPE, spot token 0) and 300 blocks in which SQD's
// dataset lists 75 of their transactions (2026-10-02).
const HYPEREVM_SYSTEM_SENDERS = ["0x2222222222222222222222222222222222222222", "0x2000000000000000000000000000000000000000"]
const HYPEREVM_SAMPLE_FROM = 47479240
const HYPEREVM_SAMPLE_TO = 47479540 // exclusive
// Distinct owners on 2026-10-02 (any balance): one below, one above 5,000.
const HOLDER_SAMPLES = [
  { symbol: "Stunk", mint: "FLk6FKAN26m1FT4ucguwy3uHBMzLKcEu8KMTYD2Zpump", owners: 1543 },
  { symbol: "Kirkiversary", mint: "915YcCbtupYLTz3RwfKjYngzBG2Bk2RX8We4D2HSpump", owners: 8011 },
]

export const verifyTxCounts = async (): Promise<boolean> => {
  const results: CheckResult[] = []
  const record = (check: string, status: Status, detail: string) => {
    results.push({ check, status, detail })
    console.log(`[verify] ${status} — ${check}: ${detail}`)
  }
  const attempt = async (check: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      record(check, "FAIL", message(err))
    }
  }

  // --- EVM / HyperSync -----------------------------------------------------
  if (!String(process.env.ENVIO_API_TOKEN || "").trim()) {
    record("HyperSync", "SKIP", "ENVIO_API_TOKEN is not set (free token: https://envio.dev/app/api-tokens)")
  } else {
    await attempt("HyperSync: PNK successful txs through block 26,095,339", async () => {
      const res = await countEvmTxsWithHypersync(
        { "1": [PNK] },
        { persist: false, toBlockByChain: { "1": PNK_TO_BLOCK_EXCLUSIVE } }
      )
      const count = res.counts["1"][PNK]
      const chain = res.chains[0]
      record(
        "HyperSync: PNK successful txs through block 26,095,339",
        count === PNK_SUCCESSFUL ? "PASS" : "FAIL",
        `${count} (expected ${PNK_SUCCESSFUL}); ${chain.requests} requests in ${(chain.elapsedMs / 1000).toFixed(1)} s`
      )
    })
    await attempt("HyperSync: PNK all txs (incl. failed) through block 26,095,339", async () => {
      const res = await countEvmTxsWithHypersync(
        { "1": [PNK] },
        { persist: false, successOnly: false, toBlockByChain: { "1": PNK_TO_BLOCK_EXCLUSIVE } }
      )
      const count = res.counts["1"][PNK]
      record(
        "HyperSync: PNK all txs (incl. failed) through block 26,095,339",
        count === PNK_ALL ? "PASS" : "FAIL",
        `${count} (expected ${PNK_ALL})`
      )
    })
    await attempt("HyperSync: history starts at genesis on every EVM chain", async () => {
      const late: string[] = []
      const seen: string[] = []
      for (const chain of chains.filter((c) => c.namespaceId === "eip155")) {
        const first = await firstIndexedBlock(chain.id)
        seen.push(`${chain.label}=${first === null ? "none" : first}`)
        if (first === null || first > 1) late.push(`${chain.label} (${chain.id})`)
      }
      record(
        "HyperSync: history starts at genesis on every EVM chain",
        late.length === 0 ? "PASS" : "FAIL",
        late.length === 0
          ? `first block in 0..99: ${seen.join(", ")}`
          : `no blocks 0..99 for ${late.join(", ")}: early history may be missing there (${seen.join(", ")})`
      )
    })
    const preByzantiumCheck = "HyperSync: pre-Byzantium successes (The DAO, blocks < 4,370,000)"
    await attempt(preByzantiumCheck, async () => {
      const res = await countEvmTxsWithHypersync(
        { "1": [THE_DAO] },
        { persist: false, toBlockByChain: { "1": 4370000 } }
      )
      const count = res.counts["1"][THE_DAO]
      const noStatus = res.chains[0].preByzantiumNullStatusRows || 0
      // HyperSync either carries a status for these receipts (some nodes
      // compute one by re-executing) or none at all; anything else is wrong.
      let expected = NaN
      let detail = `some of the ${THE_DAO_CALLS} rows have a status and some do not`
      if (noStatus === 0) {
        expected = THE_DAO_SUCCESSFUL
        detail = "HyperSync carries a status for these receipts; it must match execution"
      } else if (noStatus === THE_DAO_CALLS) {
        expected = THE_DAO_GAS_OR_LOGS
        detail =
          "no status, counted by the gas-or-logs rule, which misses " +
          `${THE_DAO_SUCCESSFUL - THE_DAO_GAS_OR_LOGS} successes that used their whole gas limit and emitted no log`
      }
      record(
        preByzantiumCheck,
        count === expected ? "PASS" : "FAIL",
        `${count} successful (expected ${Number.isNaN(expected) ? "a consistent status" : expected}); ` +
          `${noStatus} of ${THE_DAO_CALLS} rows had no status: ${detail}`
      )
    })
    await attempt("HyperSync: throughput sample (USDC on Base, last ~24 h)", async () => {
      const to = (await getHypersyncHeight("8453")) - 200
      const from = to - 43200
      const res = await countEvmTxsWithHypersync(
        { "8453": [BASE_USDC] },
        { persist: false, fromBlockByChain: { "8453": from }, toBlockByChain: { "8453": to } }
      )
      const chain = res.chains[0]
      const perRequest = chain.requests > 0 ? chain.rows / chain.requests : 0
      const rawPerMinute = String(process.env.HYPERSYNC_REQUESTS_PER_MINUTE || "").trim()
      const perMinute = rawPerMinute === "" ? 14 : Number(rawPerMinute)
      const rowsPerSecond = chain.elapsedMs > 0 ? chain.rows / (chain.elapsedMs / 1000) : 0
      let projection = "no rows measured, no projection"
      if (perMinute > 0 && perRequest > 0) {
        projection = `at ${perMinute} requests/min, 1 billion rows ≈ ${(1e9 / perRequest / perMinute / 60).toFixed(1)} h`
      } else if (rowsPerSecond > 0) {
        projection = `pacing off; at the measured ${rowsPerSecond.toFixed(0)} rows/s, 1 billion rows ≈ ${(1e9 / rowsPerSecond / 3600).toFixed(1)} h`
      }
      record(
        "HyperSync: throughput sample (USDC on Base, last ~24 h)",
        "INFO",
        `${chain.rows} txs in ${chain.requests} requests = ${perRequest.toFixed(0)} rows/request ` +
          `(${(chain.elapsedMs / 1000).toFixed(1)} s). ${projection}`
      )
    })
    const systemCheck = "HyperSync: HyperEVM system transactions are left out (as documented)"
    await attempt(systemCheck, async () => {
      const rows = await countTransactionsFrom("999", HYPEREVM_SYSTEM_SENDERS, HYPEREVM_SAMPLE_FROM, HYPEREVM_SAMPLE_TO)
      record(
        systemCheck,
        rows === 0 ? "PASS" : "FAIL",
        rows === 0
          ? "0 transactions from 0x2222…2222 / 0x2000…0000 in blocks 47,479,240–47,479,539 (SQD lists 75): " +
              "HyperEVM counts are user-signed transactions only"
          : `${rows} transactions from 0x2222…2222 / 0x2000…0000 (SQD lists 75): HyperSync returns system ` +
              "transactions, so update the HyperEVM note in the README and hypersync-enrichment.ts"
      )
    })
  }

  // --- Solana --------------------------------------------------------------
  const urls = String(process.env.SOLANA_RPC_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const solanaChain = chains.find((c) => c.namespaceId === "solana")
  if (urls.length === 0) urls.push(solanaChain ? solanaChain.rpc : "https://api.mainnet-beta.solana.com")
  for (const url of urls) {
    const check = `Solana RPC ${maskRpcUrl(url)}: reachable and serves old history`
    await attempt(check, async () => {
      const pool = new SolanaRpcPool([{ url }])
      const tip = await pool.call<number>("getSlot", [{ commitment: "finalized" }])
      const anchor = await findAnchor(pool, 60000000, 60000200)
      if (!anchor) throw new Error("no block found near slot 60,000,000 (archive not served?)")
      const page = await pool.call<{ slot: number }[]>("getSignaturesForAddress", [
        USDC_SOLANA_MINT,
        { limit: 10, before: anchor.signature, commitment: "finalized" },
      ])
      const archival = Array.isArray(page) && page.length > 0 && page.every((s) => s.slot <= anchor.slot)
      // fetch looks split cursors up this way before trusting an empty page.
      const statuses = await pool.call<{ value?: unknown[] }>("getSignatureStatuses", [
        [anchor.signature],
        { searchTransactionHistory: true },
      ])
      const lookup = !!(statuses && Array.isArray(statuses.value) && statuses.value[0])
      record(
        check,
        archival && lookup ? "PASS" : "FAIL",
        `finalized slot ${tip}; signatures before slot ${anchor.slot} (Jan 2021) ${archival ? "served" : "MISSING"}; ` +
          `that block's last transaction ${lookup ? "found" : "NOT found"} by getSignatureStatuses (searchTransactionHistory)`
      )
    })
    const exactCheck = `Solana RPC ${maskRpcUrl(url)}: CIGR signatures up to 2026-10-01`
    await attempt(exactCheck, async () => {
      const started = Date.now()
      const res = await countSignaturesExact(new SolanaRpcPool([{ url }]), CIGR, { maxBlockTime: CIGR_CUTOFF })
      const total = res.successful + res.failed
      record(
        exactCheck,
        res.successful === CIGR_SUCCESSFUL && total === CIGR_ALL ? "PASS" : "FAIL",
        `${res.successful} successful / ${total} total (expected ${CIGR_SUCCESSFUL} / ${CIGR_ALL}); ` +
          `${res.pages} pages in ${((Date.now() - started) / 1000).toFixed(0)} s`
      )
    })
    // fetch splits histories with cursors that do not involve the address and
    // ends a count on an empty page, so a URL must refuse a cursor it does not
    // know rather than answer [] (old Agave) or ignore it (newest page).
    const cursorCheck = `Solana RPC ${maskRpcUrl(url)}: rejects unknown cursors`
    await attempt(cursorCheck, async () => {
      const pool = new SolanaRpcPool([{ url }])
      const answers: string[] = []
      let status: Status = "PASS"
      for (const field of ["before", "until"]) {
        const fakeSignature = utils.base58.encode(randomBytes(64))
        try {
          const page = await pool.call<unknown[]>("getSignaturesForAddress", [
            USDC_SOLANA_MINT,
            { limit: 10, commitment: "finalized", [field]: fakeSignature },
          ])
          const size = Array.isArray(page) ? page.length : 0
          answers.push(`${field}: ${size === 0 ? "[]" : `${size} signatures`}`)
          // A page for an unknown `before` means the cursor is ignored (fetch
          // rejects such pages, but this URL cannot serve split counts); an
          // empty answer is the old silent behavior (Agave < 4.0): fetch then
          // looks the cursor up with getSignatureStatuses before trusting it.
          if (field === "before" && size > 0) status = "FAIL"
          else if (status === "PASS") status = "INFO"
        } catch (err) {
          if (!(err instanceof SolanaRpcError) || err.code === undefined) throw err
          answers.push(`${field}: error ${err.code}`)
        }
      }
      record(cursorCheck, status, `${answers.join("; ")} (an error such as -32020 is expected for both)`)
    })
  }
  if (urls.length > 1) {
    const windowCheck = "Solana RPC URLs: same 1,000-signature window, same order"
    await attempt(windowCheck, async () => {
      const anchor = await findAnchor(new SolanaRpcPool([{ url: urls[0] }]), WINDOW_SLOT, WINDOW_SLOT + 200)
      if (!anchor) throw new Error(`no block found near slot ${WINDOW_SLOT}`)
      const windows: string[][] = []
      for (const url of urls) {
        const page = await new SolanaRpcPool([{ url }]).call<{ signature: string }[]>("getSignaturesForAddress", [
          USDC_SOLANA_MINT,
          { limit: 1000, before: anchor.signature, commitment: "finalized" },
        ])
        windows.push(page.map((s) => s.signature))
      }
      const reference = windows[0]
      const inReference = new Set(reference)
      const differences: string[] = []
      urls.slice(1).forEach((url, i) => {
        const other = windows[i + 1]
        if (other.join() === reference.join()) return
        const inOther = new Set(other)
        const missing = reference.filter((s) => !inOther.has(s)).length
        const extra = other.filter((s) => !inReference.has(s)).length
        differences.push(
          `${maskRpcUrl(url)}: ${missing || extra ? `${missing} missing, ${extra} extra` : "same signatures in another order"}`
        )
      })
      record(
        windowCheck,
        differences.length === 0 ? "PASS" : "FAIL",
        differences.length === 0
          ? `${reference.length} USDC signatures before slot ${anchor.slot}, identical on all ${urls.length} URLs`
          : `${differences.join("; ")} (compared with ${maskRpcUrl(urls[0])}); one count pages through ` +
              "several URLs, so keep only URLs that agree in SOLANA_RPC_URLS"
      )
    })
  }

  const pool = defaultSolanaRpcPool()
  await attempt("Solana: HTC signatures up to the March 2026 run", async () => {
    const started = Date.now()
    const res = await countSignaturesExact(pool, HTC, { maxBlockTime: HTC_CUTOFF })
    const total = res.successful + res.failed
    record(
      "Solana: HTC signatures up to the March 2026 run",
      res.successful === HTC_SUCCESSFUL && total === HTC_ALL ? "PASS" : "FAIL",
      `${res.successful} successful / ${total} total (expected ${HTC_SUCCESSFUL} / ${HTC_ALL}); ` +
        `${res.pages} pages in ${((Date.now() - started) / 1000).toFixed(0)} s`
    )
  })
  await attempt("Solana: holder check (Jupiter, then getProgramAccounts)", async () => {
    const holders = await checkHolders(pool, HOLDER_SAMPLES.map((h) => h.mint))
    const changed = HOLDER_SAMPLES.filter((h) => (holders[h.mint].holders >= 5000) !== (h.owners >= 5000))
    record(
      "Solana: holder check (Jupiter, then getProgramAccounts)",
      changed.length === 0 ? "PASS" : "INFO",
      HOLDER_SAMPLES.map(
        (h) => `${h.symbol} ${holders[h.mint].holders} via ${holders[h.mint].source} (2026-10-02: ${h.owners} owners)`
      ).join("; ") + (changed.length ? " — verdict changed since 2026-10-02, check manually" : "")
    )
  })

  console.log("\n=== verify-counts summary ===")
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.check}`)
  const failed = results.filter((r) => r.status === "FAIL").length
  console.log(failed === 0 ? "\nNo failures." : `\n${failed} check(s) failed — do not run fetch for payouts until they pass.`)
  return failed === 0
}
