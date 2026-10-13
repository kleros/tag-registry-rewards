import { spawn } from "child_process"
import { join, resolve } from "path"
import { EnvVars } from "./env"

export const REPO = resolve(__dirname, "..", "..")
const TS_NODE = require.resolve("ts-node/register/transpile-only", { paths: [REPO] })
const HERMETIC = join(__dirname, "hermetic.js")

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  output: string // both, interleaved as received
}

// Runs `src/cli.ts <args>` like `yarn start` does, in `cwd`, with the test
// process's environment plus `env`. The child keeps the network guard
// (hermetic.js with HERMETIC_CHILD=1), so it only reaches the test's mocks.
export const runCli = (args: string[], opts: { cwd: string; env?: EnvVars; timeoutMs?: number }): Promise<CliResult> =>
  runNode([join(REPO, "src", "cli.ts"), ...args], opts)

export const runNode = (args: string[], opts: { cwd: string; env?: EnvVars; timeoutMs?: number; preload?: boolean }): Promise<CliResult> =>
  new Promise((resolvePromise, reject) => {
    const env: { [key: string]: string } = {}
    const merged: EnvVars = {
      ...process.env,
      TS_NODE_PROJECT: join(REPO, "tsconfig.json"),
      TS_NODE_TRANSPILE_ONLY: "true",
      HERMETIC_CHILD: "1",
      FORCE_COLOR: "0",
      ...opts.env,
    }
    for (const key of Object.keys(merged)) if (merged[key] !== undefined) env[key] = merged[key] as string
    const preload = opts.preload === false ? [] : ["--require", TS_NODE, "--require", HERMETIC]
    const child = spawn(process.execPath, [...preload, ...args], { cwd: opts.cwd, env })
    let stdout = ""
    let stderr = ""
    let output = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      output += chunk
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`CLI timed out after ${opts.timeoutMs || 60000} ms: ${args.join(" ")}\n${output}`))
    }, opts.timeoutMs || 60000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, output })
    })
  })
