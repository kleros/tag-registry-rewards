import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { utils, Wallet } from "ethers"
import { copyFileSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { runCli, runNode, REPO } from "../support/cli"
import { MockEvm } from "../support/evm"
import { freshDir, listFiles, oneFile, readJson, writeJson } from "../support/files"
import { evmAddress, makeTag, unix } from "../support/fixtures"

const PNK = (n: number | string) => utils.parseEther(String(n))

// A working directory with files/ holding a fetch run's outputs.
const workdirWithFetch = (opts: { period?: boolean } = {}) => {
  const dir = freshDir("cli-")
  const tags = [makeTag({ chain: "1", submitter: evmAddress(0xa1) }), makeTag({ chain: "1", submitter: evmAddress(0xa2) })]
  writeJson(join(dir, "files", "1790000000000_generate_tags.json"), tags)
  writeJson(
    join(dir, "files", "1790000000000_generate_gas.json"),
    tags.map((t, i) => ({ chain: t.chain, address: t.tagAddress.slice(2), tx_count: (i + 1) * 100 }))
  )
  if (opts.period !== false) {
    writeJson(join(dir, "files", "1790000000000_fetch_manifest.json"), {
      runId: "1790000000000",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      generateTagsFile: "1790000000000_generate_tags.json",
      generateGasFile: "1790000000000_generate_gas.json",
    })
    copyFileSync(join(dir, "files", "1790000000000_fetch_manifest.json"), join(dir, "files", "latest_fetch_manifest.json"))
  }
  return dir
}

describe("CLI arguments", { concurrency: true }, () => {
  const fails = async (args: string[], message: RegExp, env = {}) => {
    const res = await runCli(args, { cwd: freshDir("cli-"), env })
    assert.equal(res.code, 1, res.output)
    assert.match(res.stderr, message)
  }

  it("needs a mode", () => fails([], /You must choose a mode/))
  it("rejects an unknown mode", () => fails(["--mode", "pay"], /Unrecognized mode pay/))
  it("rejects a period that is not YYYY-MM", () => fails(["--mode", "document", "--period", "2026-9-15"], /Invalid --period "2026-9-15"\. Expected YYYY-MM/))
  it("rejects --period with --start", () => fails(["--mode", "removals", "--period", "2026-09", "--start", "2026-09-01"], /cannot be combined with --start\/--end/))
  it("rejects an impossible date instead of rolling it over", () => fails(["--mode", "filter-check", "--start", "2026-13-01", "--end", "2027-01-01"], /Invalid date "2026-13-01"\. Expected YYYY-MM-DD/))
  it("rejects a period that ends before it starts", () => fails(["--mode", "filter-check", "--start", "2026-10-01", "--end", "2026-09-01"], /Invalid period: 2026-10-01T00:00:00\.000Z is not before 2026-09-01/))
  it("rejects a bad --max-minutes", () => fails(["--mode", "fetch", "--max-minutes", "soon"], /Invalid --max-minutes "soon"/))
  it("refuses --max-minutes with a Dune lane, which keeps no cache", () =>
    fails(["--mode", "fetch", "--max-minutes", "5"], /--max-minutes only works with the hypersync and rpc providers/, { EVM_TX_PROVIDER: "dune" }))
  it("needs the file to send", () => fails(["--mode", "send"], /JSON file needed to send the full rewards/))
})

describe("CLI generate", () => {
  it("builds the payout from the latest fetch and records its period for send", async () => {
    const cwd = workdirWithFetch()
    const res = await runCli(["--mode", "generate"], { cwd })
    assert.equal(res.code, 0, res.output)
    const manifest = readJson(join(cwd, "files", "latest_generate_manifest.json"))
    assert.equal(manifest.periodStart, "2026-09-01T00:00:00.000Z")
    assert.equal(manifest.tagsFile, "1790000000000_generate_tags.json")
    assert.deepEqual(manifest.formulas, {
      addressTags: process.env.REWARD_FORMULA_ADDRESS_TAGS,
      tokens: process.env.REWARD_FORMULA_TOKENS,
      domains: process.env.REWARD_FORMULA_DOMAINS,
    })
    assert.ok(res.stdout.includes(`tokens:      ${process.env.REWARD_FORMULA_TOKENS}`), "the formulas are printed")
    assert.match(res.stdout, new RegExp(`Transactions file \\(for --mode send\\): ${manifest.transactionsFile}`))
    assert.deepEqual(readJson(join(cwd, "files", `${manifest.runId}_generate_manifest.json`)), manifest)
    const tx = readJson(join(cwd, "files", manifest.transactionsFile))
    assert.equal(tx.length, 2)
  })

  it("takes explicit --tags/--gas files, and their fetch manifest's period when there is one", async () => {
    const cwd = workdirWithFetch()
    const res = await runCli(["--mode", "generate", "--tags", "1790000000000_generate_tags.json", "--gas", "1790000000000_generate_gas.json"], { cwd })
    assert.equal(res.code, 0, res.output)
    assert.equal(readJson(join(cwd, "files", "latest_generate_manifest.json")).periodEnd, "2026-10-01T00:00:00.000Z")
  })

  it("finds the period of a tags file in whichever fetch manifest names it", async () => {
    const cwd = workdirWithFetch()
    copyFileSync(join(cwd, "files", "1790000000000_generate_tags.json"), join(cwd, "files", "august_tags.json"))
    copyFileSync(join(cwd, "files", "1790000000000_generate_gas.json"), join(cwd, "files", "august_gas.json"))
    writeJson(join(cwd, "files", "1780000000000_fetch_manifest.json"), {
      runId: "1780000000000",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      generateTagsFile: "august_tags.json",
      generateGasFile: "august_gas.json",
    })
    const res = await runCli(["--mode", "generate", "--tags", "august_tags.json", "--gas", "august_gas.json"], { cwd })
    assert.equal(res.code, 0, res.output)
    assert.equal(readJson(join(cwd, "files", "latest_generate_manifest.json")).periodStart, "2026-08-01T00:00:00.000Z")
    assert.doesNotMatch(res.stderr, /no fetch manifest/)
  })

  it("warns that rewards from a tags file no fetch manifest names carry no period", async () => {
    const cwd = workdirWithFetch()
    copyFileSync(join(cwd, "files", "1790000000000_generate_tags.json"), join(cwd, "files", "renamed_tags.json"))
    copyFileSync(join(cwd, "files", "1790000000000_generate_gas.json"), join(cwd, "files", "renamed_gas.json"))
    const res = await runCli(["--mode", "generate", "--tags", "renamed_tags.json", "--gas", "renamed_gas.json"], { cwd })
    assert.equal(res.code, 0, res.output)
    assert.match(res.stderr, /WARNING: no fetch manifest in files\/ gives the period of renamed_tags\.json/)
    assert.equal(readJson(join(cwd, "files", "latest_generate_manifest.json")).periodStart, undefined)
  })

  it("fails without a fetch to build from", async () => {
    const res = await runCli(["--mode", "generate"], { cwd: freshDir("cli-") })
    assert.equal(res.code, 1)
    assert.match(res.stderr, /No latest fetch manifest found/)
  })
})

describe("CLI send, end to end", () => {
  it("pays a generated file once, refuses it afterwards, and lists it", async () => {
    const cwd = workdirWithFetch()
    assert.equal((await runCli(["--mode", "generate"], { cwd })).code, 0)
    const file = readJson(join(cwd, "files", "latest_generate_manifest.json")).transactionsFile
    const evm = await new MockEvm({ startTime: unix("2026-10-02T00:00:00Z") }).start()
    const wallet = Wallet.createRandom()
    evm.setTokenBalance(wallet.address, PNK(500000))
    evm.setNativeBalance(wallet.address, PNK(1))
    const env = { TX_RPC_URL: evm.url, PNK: evm.token, WALLET_PRIVATE_KEY: wallet.privateKey, SEND_POLL_MS: "5" }
    try {
      const dry = await runCli(["--mode", "send", "--rewards", file, "--dry-run"], { cwd, env })
      assert.equal(dry.code, 0, dry.output)
      assert.match(dry.stdout, /Dry run: would send 2 transfer\(s\)/)
      assert.deepEqual(listFiles(join(cwd, "disbursements")), [])

      const first = await runCli(["--mode", "send", "--rewards", file], { cwd, env })
      assert.equal(first.code, 0, first.output)
      assert.match(first.stdout, /Done: 2 transfers confirmed/)
      assert.equal(evm.transfersFrom(wallet.address).length, 2)
      const record = oneFile(join(cwd, "disbursements"), /^2026-09-submissions-[0-9a-f]{12}\.json$/)

      const again = await runCli(["--mode", "send", "--rewards", file], { cwd, env })
      assert.equal(again.code, 1)
      assert.match(again.stderr, /Refusing to send: this payout was already disbursed/)
      assert.doesNotMatch(again.stderr, /\n\s+at /, "a refusal is printed as its message, not as a crash")
      assert.equal(evm.transfersFrom(wallet.address).length, 2, "nothing sent the second time")

      const list = await runCli(["--mode", "disbursements"], { cwd })
      assert.equal(list.code, 0)
      assert.match(list.stdout, new RegExp(`2026-09\\s+submissions\\s+completed\\s+2/2.*${file}\\s+disbursements/${record}`))
    } finally {
      await evm.stop()
    }
  })

  it("asks for --period to send a file no manifest gives the period of, under any spelling of its path", async () => {
    const cwd = workdirWithFetch()
    writeJson(join(cwd, "files", "manual.json"), [{ recipient: evmAddress(1), amount: "5" }])
    const refused = await runCli(["--mode", "send", "--rewards", "manual.json", "--dry-run"], { cwd })
    assert.equal(refused.code, 1, refused.output)
    assert.match(refused.stderr, /the period of manual\.json is unknown.*--period YYYY-MM/s)
    const res = await runCli(["--mode", "send", "--rewards", "./files/manual.json", "--dry-run", "--period", "2026-09"], { cwd })
    assert.equal(res.code, 0, res.output)
    assert.match(res.stdout, /Payout: unknown for 2026-09 \(manual\.json\)/)
  })

  it("never prints the wallet key, even when it is invalid", async () => {
    const cwd = workdirWithFetch()
    writeJson(join(cwd, "files", "1.json"), [{ recipient: evmAddress(1), amount: "5" }])
    const secret = "0xdeadbeef" + "ab".repeat(20)
    const res = await runCli(["--mode", "send", "--rewards", "1.json"], { cwd, env: { WALLET_PRIVATE_KEY: secret } })
    assert.equal(res.code, 1)
    assert.match(res.stderr, /WALLET_PRIVATE_KEY is not a valid private key/)
    assert.ok(!res.output.includes(secret.slice(2)), "the key never appears in the output")
  })
})

describe("yarn start (dotenv-safe and the documented .env.example)", () => {
  // `yarn start` runs ts-node with -r dotenv-safe/config: every uncommented
  // key of .env.example must be set in .env. The repo's own .env.example is
  // used, so a key added there without being commented out is caught here.
  const START = ["--require", require.resolve("dotenv-safe/config", { paths: [REPO] }), join(REPO, "src", "cli.ts")]
  const envFrom = (example: string): string =>
    example
      .split("\n")
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const key = line.split("=")[0]
        const value = line.slice(key.length + 1).replace(/^"|"$/g, "")
        return `${key}=${value || "set-for-test"}`
      })
      .join("\n")

  it("starts with a .env holding every key of .env.example", async () => {
    const cwd = freshDir("start-")
    const example = readFileSync(join(REPO, ".env.example"), "utf8")
    writeFileSync(join(cwd, ".env.example"), example)
    writeFileSync(join(cwd, ".env"), envFrom(example))
    const res = await runNode(START.concat(["--mode", "disbursements"]), {
      cwd,
      env: { TS_NODE_FILES: "true", ...emptyPipelineEnv() },
    })
    assert.equal(res.code, 0, res.output)
    assert.match(res.stdout, /No disbursement recorded/)
  })

  it("checks any wallet with --dry-run --from, no WALLET_PRIVATE_KEY in .env (only signing needs it)", async () => {
    const cwd = freshDir("start-")
    const example = readFileSync(join(REPO, ".env.example"), "utf8")
    writeFileSync(join(cwd, ".env.example"), example)
    const withoutKey = envFrom(example).split("\n").filter((line) => !line.startsWith("WALLET_PRIVATE_KEY="))
    writeFileSync(join(cwd, ".env"), withoutKey.join("\n"))
    writeJson(join(cwd, "files", "1790000000001.json"), [{ recipient: evmAddress(1), amount: PNK(5).toString() }])
    writeJson(join(cwd, "files", "1790000000001_generate_manifest.json"), {
      runId: "1790000000001",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      transactionsFile: "1790000000001.json",
    })
    const evm = await new MockEvm({ startTime: Math.floor(Date.now() / 1000) - 3600 }).start()
    const wallet = evmAddress(0xbe7e)
    evm.setTokenBalance(wallet, PNK(100))
    evm.setNativeBalance(wallet, PNK(1))
    try {
      const args = ["--mode", "send", "--rewards", "1790000000001.json", "--dry-run", "--from", wallet]
      const res = await runNode(START.concat(args), {
        cwd,
        env: { TS_NODE_FILES: "true", ...emptyPipelineEnv(), TX_RPC_URL: evm.url, PNK: evm.token },
      })
      assert.equal(res.code, 0, res.output)
      assert.match(res.stdout, /Dry run: would send 1 transfer\(s\)/)
    } finally {
      await evm.stop()
    }
  })

  it("refuses to start when .env misses a required key", async () => {
    const cwd = freshDir("start-")
    const example = readFileSync(join(REPO, ".env.example"), "utf8")
    writeFileSync(join(cwd, ".env.example"), example)
    writeFileSync(join(cwd, ".env"), envFrom(example).split("\n").filter((l) => !l.startsWith("STIPEND=")).join("\n"))
    const res = await runNode(START.concat(["--mode", "disbursements"]), { cwd, env: emptyPipelineEnv() })
    assert.notEqual(res.code, 0)
    assert.match(res.output, /MissingEnvVarsError|STIPEND/)
  })
})

// The pipeline's settings unset, so only the test's .env provides them.
const emptyPipelineEnv = (): { [k: string]: undefined } => {
  const out: { [k: string]: undefined } = {}
  for (const key of Object.keys(process.env)) {
    if (/^(TX_NETWORK_ID|WALLET_PRIVATE_KEY|STIPEND|MAX_REWARD|REWARD_.*|SOLANA_.*|REMOVAL_.*|MAX_PER_ATQ_.*|PNK|XDAI_.*|FILES_DIR)$/.test(key)) out[key] = undefined
  }
  return out
}
