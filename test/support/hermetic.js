"use strict"
// Preloaded into every test process, and into every CLI a test starts, by
// test/run.js. It keeps the tests away from anything real:
// - network access is limited to this machine, where the mocks listen: a call
//   to a real RPC, subgraph or explorer fails like a refused connection;
// - the working directory is a fresh temporary one, so files/, exclusions.json
//   and disbursements/ resolve inside it, never in the repo;
// - HOME and the tx-count cache point inside it too, and the pipeline settings
//   inherited from the shell are replaced by the documented test baseline.
// A CLI started by a test (HERMETIC_CHILD=1) keeps the working directory and
// environment the test gave it; only the network guard applies.
const fs = require("fs")
const net = require("net")
const os = require("os")
const path = require("path")

// TESTS_CLOCK_SHIFT_DAYS=n runs the tests n days ahead (CI runs them years
// ahead): a test that only passes while today is close to its fixtures' dates
// (a mock chain fixed in time, a month hard-coded as "not over yet") fails at
// once, not on the day it would have started to block `yarn start`. A mock
// chain fixed at 2026-10-02 once failed that way from 2026-11-16.
const shiftDays = Number(process.env.TESTS_CLOCK_SHIFT_DAYS || 0)
if (shiftDays) {
  const offset = shiftDays * 86400000
  const RealDate = Date
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...args)
    }
    static now() {
      return RealDate.now() + offset
    }
  }
  global.Date = ShiftedDate
}

const isLoopback = (host) =>
  host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1" || /^127\./.test(String(host))

const warned = new Set()
const refuse = (socket, host, port) => {
  const target = `${host}:${port}`
  if (!warned.has(target)) {
    warned.add(target)
    process.stderr.write(`[hermetic] blocked network access to ${target} (tests only reach 127.0.0.1)\n`)
  }
  const err = new Error(`hermetic test: network access to ${target} is blocked`)
  err.code = "ECONNREFUSED"
  process.nextTick(() => socket.destroy(err))
  return socket
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function connect(...args) {
  // connect(options[, cb]), connect(port[, host][, cb]), connect(path[, cb]),
  // or net's internal normalized form, an array holding the options.
  let options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof options === "number" || (typeof options === "string" && /^\d+$/.test(options))) {
    options = { port: options, host: typeof args[1] === "string" ? args[1] : "localhost" }
  }
  // As in net itself, a falsy path means TCP (agents pass path: null).
  if (options && typeof options === "object" && !options.path) {
    const host = options.host || "localhost"
    if (!isLoopback(host)) return refuse(this, host, options.port)
  }
  return originalConnect.apply(this, args)
}

// The settings a test may not inherit from the operator's shell.
const PIPELINE_SETTING = /^(TX_NETWORK_ID|WALLET_PRIVATE_KEY|STIPEND|MAX_REWARD|REWARD_.*|SOLANA_.*|EVM_.*|REMOVAL_.*|MAX_PER_ATQ_.*|PNK|XDAI_.*|FILES_DIR|FILEBASE_TOKEN|IPFS_GATEWAY|EXCLUSIONS_FILE|ENVIO_API_TOKEN|HYPERSYNC_.*|JUPITER_.*|TX_COUNT_CACHE.*|DUNE_.*|TX_RPC_URL|DISBURSEMENTS_DIR|SEND_.*)$/

// The documented configuration (.env.example) plus unreachable local URLs for
// every external service, so a test that forgets a mock fails fast.
const baseline = (tmp) => ({
  TX_NETWORK_ID: "100",
  STIPEND: "93000000000000000000000",
  MAX_REWARD: "500000000000000000000",
  REWARD_FORMULA_ADDRESS_TAGS:
    "(reward_pool/(2*total_submissions)) + ((reward_pool*txns_with_contract)/(2*total_txns_with_all_contracts))",
  REWARD_FORMULA_TOKENS:
    "((token_tx/total_txns_with_all_contracts)*0.1*reward_pool) + ((sqrt(token_tx)/sum_sqrt_total_txns_with_all_contracts)*0.9*reward_pool)",
  REWARD_FORMULA_DOMAINS:
    "(reward_pool/(2*total_submissions)) + ((reward_pool*txns_with_contract)/(2*total_txns_with_all_contracts))",
  REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS: "true",
  REWARD_REDISTRIBUTE_CAPPED_TOKENS: "false",
  REWARD_REDISTRIBUTE_CAPPED_DOMAINS: "true",
  SOLANA_TX_DIVIDER: "1000",
  SOLANA_TX_LOOKBACK_DAYS: "0",
  REMOVAL_REWARD_POOL_ADDRESS_TAGS: "7000000000000000000000",
  REMOVAL_REWARD_POOL_TOKENS: "7000000000000000000000",
  REMOVAL_REWARD_POOL_DOMAINS: "7000000000000000000000",
  REMOVAL_MAX_PER_REMOVAL_ADDRESS_TAGS: "500000000000000000000",
  REMOVAL_MAX_PER_REMOVAL_TOKENS: "500000000000000000000",
  REMOVAL_MAX_PER_REMOVAL_DOMAINS: "500000000000000000000",
  REWARD_POOL_ATQ_SUBMISSIONS: "60000000000000000000000",
  MAX_PER_ATQ_SUBMISSION: "3000000000000000000000",
  REWARD_POOL_ATQ_REMOVALS: "6500000000000000000000",
  MAX_PER_ATQ_REMOVAL: "500000000000000000000",
  PNK: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
  XDAI_GTCR_SUBGRAPH_URL: "http://127.0.0.1:9/subgraph-not-mocked",
  XDAI_REGISTRY_ADDRESS_TAGS: "0x66260c69d03837016d88c9877e61e08ef74c59f2",
  XDAI_REGISTRY_TOKENS: "0xee1502e29795ef6c2d60f8d7120596abe3bad990",
  XDAI_REGISTRY_DOMAINS: "0x957a53a994860be4750810131d9c876b2f52d6e1",
  XDAI_REGISTRY_ATQ: "0xae6aaed5434244be3699c56e7ebc828194f26dc3",
  FILES_DIR: "files",
  TX_COUNT_CACHE_DIR: path.join(tmp, "tx-count-cache"),
  DISBURSEMENTS_DIR: "disbursements",
  TX_RPC_URL: "http://127.0.0.1:9/evm-not-mocked",
  HYPERSYNC_URL_TEMPLATE: "http://127.0.0.1:9/hypersync-not-mocked/{chainId}",
  JUPITER_TOKENS_API_URL: "http://127.0.0.1:9/jupiter-not-mocked",
  DUNE_BASE_URL: "http://127.0.0.1:9/dune-not-mocked",
})

if (process.env.HERMETIC_CHILD !== "1") {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trr-test-")))
  for (const key of Object.keys(process.env)) {
    if (PIPELINE_SETTING.test(key)) delete process.env[key]
  }
  Object.assign(process.env, baseline(tmp))
  const home = path.join(tmp, "home")
  fs.mkdirSync(home)
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.HERMETIC_TMP = tmp
  process.chdir(tmp)
  process.on("exit", () => {
    try {
      process.chdir(os.tmpdir())
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
}
