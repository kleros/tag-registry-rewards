import { afterEach, beforeEach } from "node:test"
import { BigNumber, utils, Wallet } from "ethers"
import { join } from "path"
import { sendRoutine, SendOptions } from "../../src/send-routine"
import { DisbursementRecord, listDisbursements } from "../../src/utils/disbursement-ledger"
import { MockEvm } from "./evm"
import { setEnv } from "./env"
import { freshWorkdir, writeJson } from "./files"
import { evmAddress, unix } from "./fixtures"

// What the send tests share: per test a fresh working directory, a funded
// random wallet and a mock Gnosis node (after the September 2026 period,
// which most tests pay). The bindings below are live: they change per test.

export const PNK = (n: number | string): BigNumber => utils.parseEther(String(n))
export const SEPTEMBER = { periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" }
export const AUGUST = { periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" }

export type Entry = { recipient: string; amount: BigNumber | string }
export const PAYOUT: Entry[] = [
  { recipient: evmAddress(0x101), amount: PNK(500) },
  { recipient: evmAddress(0x102), amount: PNK("1234.5") },
  { recipient: evmAddress(0x103), amount: PNK(7) },
]

export let evm: MockEvm
export let wallet: Wallet
export let work: string
export const lines: string[] = []
let restoreEnv: () => void = () => undefined

export const log = (line: string): void => {
  lines.push(line)
}
export const output = (): string => lines.join("\n")

// A new mock node whose blocks start at `startTime`, the wallet funded on it.
export const startChain = async (startTime: number): Promise<void> => {
  if (evm) await evm.stop()
  evm = await new MockEvm({ startTime }).start()
  evm.setTokenBalance(wallet.address, PNK(1000000))
  evm.setNativeBalance(wallet.address, utils.parseEther("10"))
  restoreEnv()
  restoreEnv = setEnv({
    TX_RPC_URL: evm.url,
    TX_NETWORK_ID: "100",
    PNK: evm.token,
    WALLET_PRIVATE_KEY: wallet.privateKey,
    SEND_POLL_MS: "5",
    SEND_RECEIPT_TIMEOUT_SECONDS: "0.2",
    SEND_COUNTDOWN_SECONDS: "0",
  })
}

export const installSendHarness = (): void => {
  beforeEach(async () => {
    work = freshWorkdir()
    wallet = Wallet.createRandom()
    lines.length = 0
    evm = (null as unknown) as MockEvm
    await startChain(unix("2026-10-02T00:00:00Z"))
  })
  afterEach(async () => {
    restoreEnv()
    restoreEnv = () => undefined
    await evm.stop()
  })
}

// A transactions file in files/, with the manifest generate or removals writes next to it.
export const writePayout = (
  file: string,
  entries: Entry[],
  source: { kind?: "submissions" | "removals" | "atq"; period?: typeof SEPTEMBER | null } = {}
): void => {
  writeJson(join(work, "files", file), entries.map((e) => ({ amount: BigNumber.from(e.amount), recipient: e.recipient })), false)
  const period = source.period === null ? {} : source.period || SEPTEMBER
  const runId = file.replace(/\D/g, "").slice(0, 13) || "1"
  if (!source.kind || source.kind === "submissions") {
    writeJson(join(work, "files", `${runId}_generate_manifest.json`), { runId, ...period, rewardsFile: "x", transactionsFile: file })
  } else {
    writeJson(join(work, "files", `${runId}_removals_manifest.json`), {
      runId,
      ...period,
      [source.kind === "removals" ? "transactionsFile" : "atqTransactionsFile"]: file,
    })
  }
}

export const send = (file: string, opts: Partial<SendOptions> = {}) => sendRoutine({ file, ...opts }, { log })
export const paid = () => evm.transfersFrom(wallet.address)
export const ledger = (): DisbursementRecord[] => listDisbursements()
