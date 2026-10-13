import { it } from "node:test"
import { strict as assert } from "assert"
import { runCli } from "../support/cli"
import { freshDir } from "../support/files"

// The CLI loads every module of the pipeline: one run proves they all compile
// and import. The CLI's behaviour is tested in test/scenarios/cli.slow.test.ts.
it("starts, and refuses to run without a mode", async () => {
  const res = await runCli([], { cwd: freshDir("smoke-") })
  assert.equal(res.code, 1, res.output)
  assert.match(res.stderr, /You must choose a mode, 'fetch' \| 'filter-check'/)
})
