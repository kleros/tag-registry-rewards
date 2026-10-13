#!/usr/bin/env node
"use strict"
// Runs the tests with Node's built-in runner (node:test) over the TypeScript
// test files, compiled by ts-node (transpile only). Every test process
// preloads test/support/hermetic.js: no network beyond 127.0.0.1, a temporary
// working directory, and the documented settings instead of the shell's.
//
//   node test/run.js              everything: type check, then every test
//   node test/run.js --fast       every test except *.slow.test.ts, no type check
//   node test/run.js --slow       only *.slow.test.ts
//   node test/run.js --gate       the fast tests, quietly: `yarn start` runs this
//                                 first and stops if a test fails
//   node test/run.js <file…>      only these test files
//   --grep <pattern>              only the tests whose name matches
//   --coverage                    also print line/branch coverage per file
//
// A run still going after 15 minutes (TESTS_TIMEOUT_SECONDS) is stopped, its
// test processes too: a hanging test must not block `yarn start` for good.
//
// SKIP_TESTS=1 skips the gate (`yarn start` then runs without its tests).
const { spawn, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const gate = has("--gate")
const fast = has("--fast") || gate
const slowOnly = has("--slow")
const grep = valueOf("--grep")
const coverage = has("--coverage")
const explicit = argv.filter((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--grep")

if (gate && /^(1|true|yes|on)$/i.test(String(process.env.SKIP_TESTS || "").trim())) {
  console.warn("[tests] SKIP_TESTS is set: running without the preflight tests.")
  process.exit(0)
}

const findTests = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findTests(full))
    else if (entry.name.endsWith(".test.ts")) out.push(full)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
const isSlow = (file) => file.endsWith(".slow.test.ts")

let files = explicit.length > 0 ? explicit.map((file) => path.resolve(file)) : findTests(__dirname)
if (explicit.length === 0) {
  if (fast) files = files.filter((file) => !isSlow(file))
  if (slowOnly) files = files.filter(isSlow)
}
if (files.length === 0) {
  console.error("[tests] no test files selected")
  process.exit(1)
}

const typecheck = () => {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc")
  const started = Date.now()
  const res = spawnSync(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.typecheck.json")], {
    cwd: ROOT,
    stdio: "inherit",
  })
  if (res.status !== 0) {
    console.error("[tests] type check failed (yarn typecheck)")
    process.exit(res.status || 1)
  }
  console.log(`[tests] type check passed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

if (explicit.length === 0 && !fast && !slowOnly) typecheck()

// Node 18 (the README's fallback for Windows installs) has no --test-timeout
// (Node 20.11+): there, only the watchdog below stops a test that hangs.
const supportsFlag = (flag) => spawnSync(process.execPath, [flag, "-e", ""], { stdio: "ignore" }).status === 0
const TEST_TIMEOUT_MS = 180000
const RUN_TIMEOUT_MS = Number(process.env.TESTS_TIMEOUT_SECONDS) * 1000 || 15 * 60000

const nodeArgs = [
  "--require",
  require.resolve("ts-node/register/transpile-only", { paths: [ROOT] }),
  "--require",
  path.join(__dirname, "support", "hermetic.js"),
  "--test",
  ...(supportsFlag(`--test-timeout=${TEST_TIMEOUT_MS}`) ? [`--test-timeout=${TEST_TIMEOUT_MS}`] : []),
  "--test-reporter=spec",
  ...(grep ? [`--test-name-pattern=${grep}`] : []),
  ...(coverage ? ["--experimental-test-coverage"] : []),
  ...files,
]
const env = {
  ...process.env,
  TS_NODE_PROJECT: path.join(ROOT, "tsconfig.json"),
  TS_NODE_TRANSPILE_ONLY: "true",
  FORCE_COLOR: gate ? "0" : process.env.FORCE_COLOR,
}
// Set inside a test process: node --test would then skip every file.
delete env.NODE_TEST_CONTEXT
const started = Date.now()

// The tests run in a process group of their own, so that a run that hangs,
// or Ctrl+C, stops every test process, not only the runner above them
// (Windows: the process tree, as a group of its own would open a console).
const ownGroup = process.platform !== "win32"
const stopAll = (child, signal) => {
  if (!ownGroup) {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe")
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}
const start = (stdio) => {
  const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, env, stdio, detached: ownGroup })
  // A run that hangs fails instead of blocking `yarn start` for good.
  const timer = setTimeout(() => {
    console.error(`[tests] stopped after ${RUN_TIMEOUT_MS / 1000} s: a test is hanging`)
    stopAll(child, "SIGKILL")
  }, RUN_TIMEOUT_MS)
  timer.unref()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stopAll(child, signal)
      process.exit(128 + (os.constants.signals[signal] || 1))
    })
  }
  return child
}

if (!gate) {
  const child = start("inherit")
  child.on("close", (code, signal) => process.exit(signal ? 1 : code))
} else {
  // Quiet: one line when everything passes, the full report when not.
  const child = start(["ignore", "pipe", "pipe"])
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  child.on("close", (code, signal) => {
    const count = (label) => {
      const match = new RegExp(`^ℹ ${label} (\\d+)`, "m").exec(output)
      return match ? Number(match[1]) : 0
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (code === 0 && !signal && count("pass") > 0) {
      console.log(`[tests] ${count("pass")} preflight tests passed in ${seconds} s (yarn test runs the full suite)`)
      process.exit(0)
    }
    process.stdout.write(output)
    const failed = count("fail")
    console.error(
      `\n[tests] ${failed > 0 ? `${failed} preflight test(s) failed` : "the preflight tests could not run (see above)"}, ` +
        "so the command was not run. Fix the failure (yarn test:fast shows it again), or run with SKIP_TESTS=1 at your own risk."
    )
    process.exit(code || 1)
  })
}
