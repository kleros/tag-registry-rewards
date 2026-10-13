import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { spawn } from "child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { runNode } from "../support/cli"
import { freshDir } from "../support/files"

// The tx-count cache lock between real processes: two runs starting in the
// same millisecond never both get it, a stale lock is never taken over, and
// Ctrl+C or a termination signal releases it.
const CHILD = join(__dirname, "..", "support", "lock-child.ts")

describe("cache lock between processes", () => {
  const race = async (dir: string) => {
    const startAt = String(Date.now() + 3000)
    const env = { TX_COUNT_CACHE_DIR: dir, TX_COUNT_CACHE: "on", START_AT: startAt, PAUSE: "1" }
    const runs = await Promise.all([0, 1].map(() => runNode([CHILD], { cwd: dir, env, timeoutMs: 30000 })))
    return runs.map((r) => r.stdout.trim())
  }

  it("two runs starting together: exactly one gets a free lock", async () => {
    const dir = freshDir("lock-")
    const outs = await race(dir)
    assert.equal(outs.filter((o) => o.startsWith("acquired")).length, 1, outs.join(" | "))
    assert.ok(outs.some((o) => /Another run \(pid \d+\) is using/.test(o)))
  })

  it("two runs starting together: neither takes over a stale lock", async () => {
    const dir = freshDir("lock-")
    writeFileSync(join(dir, ".lock"), "999999")
    const outs = await race(dir)
    assert.equal(outs.filter((o) => o.startsWith("acquired")).length, 0, outs.join(" | "))
    assert.equal(readFileSync(join(dir, ".lock"), "utf8"), "999999")
    assert.deepEqual(readdirSync(dir), [".lock"])
  })

  it("Ctrl+C, SIGTERM and SIGHUP release the lock and still end the run", { skip: process.platform === "win32" }, async () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      const dir = freshDir("lock-")
      const child = spawn(
        process.execPath,
        ["--require", require.resolve("ts-node/register/transpile-only"), CHILD],
        { env: { ...process.env, HERMETIC_CHILD: "1", TS_NODE_TRANSPILE_ONLY: "true", TX_COUNT_CACHE_DIR: dir, TX_COUNT_CACHE: "on", HOLD: "1" } }
      )
      const ended = new Promise<string | null>((resolve) => child.on("close", (_code, sig) => resolve(sig)))
      const deadline = Date.now() + 20000
      while (!existsSync(join(dir, ".lock")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 300))
      child.kill(signal)
      assert.equal(await ended, signal, `${signal} ends the run`)
      assert.ok(!existsSync(join(dir, ".lock")), `${signal} released the lock`)
    }
  })
})
