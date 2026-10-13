import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { REPO, runNode } from "../support/cli"
import { freshDir } from "../support/files"

// test/run.js itself: what `yarn test` and the `yarn start` gate rely on.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("test/run.js", () => {
  it("stops a run that hangs, with every test process it started", { skip: process.platform === "win32" }, async () => {
    const dir = freshDir("runner-")
    const pidFile = join(dir, "worker.pid")
    const hanging = join(dir, "hanging.test.js")
    writeFileSync(
      hanging,
      'require("fs").writeFileSync(process.env.HANG_PID_FILE, String(process.pid))\n' +
        'require("node:test").it("never ends", () => new Promise(() => setInterval(() => undefined, 1000)))\n'
    )
    const res = await runNode([join(REPO, "test", "run.js"), hanging], {
      cwd: dir,
      env: { TESTS_TIMEOUT_SECONDS: "3", HANG_PID_FILE: pidFile },
      preload: false,
    })
    assert.notEqual(res.code, 0)
    assert.match(res.stderr, /stopped after 3 s: a test is hanging/)
    assert.ok(existsSync(pidFile), "the hanging test ran")
    const pid = Number(readFileSync(pidFile, "utf8"))
    try {
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(!alive(pid), "the hanging test process was stopped too")
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  })
})
