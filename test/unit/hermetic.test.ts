import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { homedir, tmpdir } from "os"
import { resolve } from "path"
import fetch from "node-fetch"
import { ethers } from "ethers"
import { startMockServer } from "../support/http"

// The guard every test runs under (test/support/hermetic.js): tests never
// reach a real RPC, indexer or explorer, nor write into the repo or home.
describe("hermetic test environment", () => {
  it("blocks network access beyond this machine", async () => {
    await assert.rejects(fetch("https://rpc.gnosischain.com", { method: "POST", body: "{}" }), /hermetic test: network access to rpc\.gnosischain\.com:443 is blocked/)
    const provider = new ethers.providers.StaticJsonRpcProvider("https://eth.llamarpc.com", 1)
    await assert.rejects(provider.getBlockNumber())
  })

  it("lets tests reach their local mocks", async () => {
    const server = await startMockServer(() => ({ body: { ok: true } }))
    const res = await fetch(server.url)
    assert.deepEqual(await res.json(), { ok: true })
    await server.close()
  })

  it("runs in a temporary directory, with a temporary home", () => {
    const repo = resolve(__dirname, "..", "..")
    assert.ok(!process.cwd().startsWith(repo), `cwd ${process.cwd()} is inside the repo`)
    assert.ok(process.cwd().startsWith(process.env.HERMETIC_TMP as string))
    assert.ok(homedir().startsWith(process.env.HERMETIC_TMP as string))
    assert.ok((process.env.HERMETIC_TMP as string).startsWith(resolve(tmpdir())) || (process.env.HERMETIC_TMP as string).includes("trr-test-"))
  })

  it("replaces the shell's pipeline settings with the documented ones", () => {
    assert.equal(process.env.WALLET_PRIVATE_KEY, undefined)
    assert.equal(process.env.FILES_DIR, "files")
    assert.equal(process.env.STIPEND, "93000000000000000000000")
    assert.ok(String(process.env.TX_COUNT_CACHE_DIR).startsWith(process.env.HERMETIC_TMP as string))
    assert.match(String(process.env.TX_RPC_URL), /^http:\/\/127\.0\.0\.1:9\//)
  })
})
