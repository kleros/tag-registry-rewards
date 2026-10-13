// A process taking the tx-count cache lock, for the multi-process lock tests
// (test/scenarios/lock-processes.slow.test.ts). With PAUSE=1 every file
// operation on the lock waits 300 ms first, to widen any race window.
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require("fs")
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (const name of ["unlinkSync", "renameSync", "linkSync", "readFileSync"]) {
  const original = fs[name]
  fs[name] = (...args: unknown[]) => {
    if (String(args[0]).includes(".lock") && process.env.PAUSE) nap(300)
    return original(...args)
  }
}
const cache = require("../../src/utils/tx-count-cache")
while (Date.now() < Number(process.env.START_AT || 0)) nap(5)
try {
  cache.acquireTxCountCacheLock()
  process.stdout.write("acquired\n")
  if (process.env.HOLD) setTimeout(() => process.exit(0), 20000) // until a signal ends it
  else {
    nap(2500)
    process.exit(0)
  }
} catch (err) {
  process.stdout.write(`refused: ${String((err as Error).message)}\n`)
  process.exit(0)
}
