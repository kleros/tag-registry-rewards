import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { maskRpcUrl, redactSecrets, SolanaRpcPool, solanaRpcConfigs, solanaRpcUrls } from "../../src/utils/solana-rpc"
import {
  assertSolanaRpcSettings,
  defaultSolanaRpcUrl,
  getSolanaCountMode,
  isSolanaAddress,
} from "../../src/utils/solana-rpc-enrichment"
import { withEnv } from "../support/env"

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=0123456789abcdef-SECRET"
const ALCHEMY = "https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz123456"

describe("masking RPC URLs", () => {
  it("hides query strings and long path segments, keeping the host", () => {
    assert.equal(maskRpcUrl(HELIUS), "mainnet.helius-rpc.com?***")
    assert.equal(maskRpcUrl(ALCHEMY), "solana-mainnet.g.alchemy.com/v2/***")
    assert.equal(maskRpcUrl("https://api.mainnet-beta.solana.com"), "api.mainnet-beta.solana.com")
    assert.equal(maskRpcUrl("not a url"), "<invalid url>")
  })

  it("redacts every URL and every known secret from error texts, in any encoding", () => {
    const secret = "0123456789abcdef-SECRET"
    const text =
      `request to ${HELIUS} failed; key ${secret}; encoded ${encodeURIComponent("p@ss/word-" + secret)}; ` +
      `alchemy https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz123456/extra`
    const out = redactSecrets(text, [HELIUS, ALCHEMY])
    assert.ok(!out.includes(secret), out)
    assert.ok(!out.includes("AbCdEfGhIjKlMnOpQrStUvWxYz123456"), out)
    assert.ok(out.includes("mainnet.helius-rpc.com?***"))
    // a made-up password, assembled so secretlint does not take it for a real credential
    const withPassword = ["https://user", ":", "hunter22hunter", "@db.example.com/x"].join("")
    const user = redactSecrets(`db at ${withPassword} and hunter22hunter alone`, [withPassword])
    assert.ok(!user.includes("hunter22hunter"), user)
  })

  it("leaves texts without secrets alone", () => {
    assert.equal(redactSecrets("plain error", []), "plain error")
  })
})

describe("SOLANA_RPC_URLS and the per-URL overrides", () => {
  const configs = async (urls: string | undefined, rps = "", inflight = "") =>
    withEnv({ SOLANA_RPC_URLS: urls, SOLANA_RPC_MAX_RPS: rps, SOLANA_RPC_MAX_INFLIGHT: inflight }, () => {
      try {
        return JSON.stringify(solanaRpcConfigs())
      } catch (err) {
        return `throws: ${(err as Error).message}`
      }
    })

  it("matches overrides to URLs by position; empty or 0 keeps the provider default", async () => {
    assert.equal(await configs("http://a,http://b,http://c", "9,,0.75"), '[{"url":"http://a","rps":9},{"url":"http://b"},{"url":"http://c","rps":0.75}]')
    assert.equal(await configs("http://a", "0", "0"), '[{"url":"http://a"}]')
    assert.equal(await configs("http://a,http://b,", "9,1"), '[{"url":"http://a","rps":9},{"url":"http://b","rps":1}]')
    assert.equal(await configs("http://a,http://b", "9"), '[{"url":"http://a","rps":9},{"url":"http://b"}]')
  })

  it("drops empty entries when no override needs their position", async () => {
    assert.equal(await configs("http://a,,http://b"), '[{"url":"http://a"},{"url":"http://b"}]')
  })

  it("refuses ambiguous or malformed overrides instead of guessing", async () => {
    assert.match(await configs(",http://a,http://b", "9,1"), /throws: .*empty entry/)
    assert.match(await configs("http://a,http://b", "9,7,0.75"), /throws: .*more values than the 2 RPC URL/)
    assert.match(await configs("http://a", "fast"), /throws: .*Invalid SOLANA_RPC_MAX_RPS entry "fast"/)
    assert.match(await configs("http://a", "", "2.5"), /throws: .*Invalid SOLANA_RPC_MAX_INFLIGHT entry "2\.5"/)
    assert.match(await configs("http://a", "-1"), /throws: .*Invalid SOLANA_RPC_MAX_RPS/)
  })

  it("applies overrides to the fallback URL when SOLANA_RPC_URLS is empty", async () => {
    await withEnv({ SOLANA_RPC_URLS: undefined, SOLANA_RPC_MAX_RPS: "0.5" }, () => {
      assert.equal(JSON.stringify(solanaRpcConfigs("http://fallback")), '[{"url":"http://fallback","rps":0.5}]')
      assert.deepEqual(solanaRpcUrls("http://fallback"), ["http://fallback"])
    })
  })

  it("defaults to the public mainnet endpoint of chains.ts", () => {
    assert.equal(defaultSolanaRpcUrl(), "https://api.mainnet-beta.solana.com")
  })

  it("paces each provider by its known limits unless overridden", () => {
    const pool = new SolanaRpcPool([
      { url: "https://api.mainnet-beta.solana.com" },
      { url: HELIUS },
      { url: ALCHEMY },
      { url: "https://rpc.example.com" },
      { url: "https://rpc.example.com/override", rps: 20, inFlight: 3 },
    ])
    assert.deepEqual(
      pool.stats().map((s) => s.rps),
      [0.8, 9, 7, 5, 20]
    )
    assert.equal(pool.capacity(), 5 + 30 + 30 + 10 + 3)
    assert.deepEqual(pool.endpointOrder(true), [0, 1, 2, 3, 4])
    assert.equal(pool.labels()[1], "mainnet.helius-rpc.com?***", "labels never carry keys")
    assert.throws(() => new SolanaRpcPool([]), /no RPC URL configured/)
  })
})

describe("Solana settings checked before a run", () => {
  it("recognises base58 addresses of 32 to 44 characters", () => {
    assert.equal(isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), true)
    assert.equal(isSolanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), true)
    assert.equal(isSolanaAddress("0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d"), false)
    assert.equal(isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O"), false, "O is not base58")
    assert.equal(isSolanaAddress("short"), false)
  })

  it("reads SOLANA_COUNT_MODE, auto by default", async () => {
    await withEnv({ SOLANA_COUNT_MODE: undefined }, () => assert.equal(getSolanaCountMode(), "auto"))
    await withEnv({ SOLANA_COUNT_MODE: " EXACT " }, () => assert.equal(getSolanaCountMode(), "exact"))
    await withEnv({ SOLANA_COUNT_MODE: "sampled" }, () => assert.throws(() => getSolanaCountMode(), /Invalid SOLANA_COUNT_MODE="sampled"/))
  })

  it("fails fast on a typo in any Solana setting", async () => {
    await withEnv({}, () => assertSolanaRpcSettings())
    const bad: [string, string, RegExp][] = [
      ["SOLANA_COUNT_MODE", "fast", /SOLANA_COUNT_MODE/],
      ["SOLANA_EXACT_BELOW", "1.5M", /Invalid SOLANA_EXACT_BELOW/],
      ["SOLANA_SAMPLE_STRATA", "-3", /Invalid SOLANA_SAMPLE_STRATA/],
      ["SOLANA_ESTIMATE_ABOVE", "lots", /Invalid SOLANA_ESTIMATE_ABOVE/],
      ["SOLANA_RPC_MAX_RPS", "x", /Invalid SOLANA_RPC_MAX_RPS/],
      ["SOLANA_TX_LOOKBACK_DAYS", "30", /not supported by the rpc provider/],
    ]
    for (const [key, value, message] of bad) {
      await withEnv({ [key]: value }, () => assert.throws(() => assertSolanaRpcSettings(), message))
    }
    await withEnv({ SOLANA_TX_LOOKBACK_DAYS: "0" }, () => assertSolanaRpcSettings())
  })
})
