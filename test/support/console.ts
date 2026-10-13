import { inspect } from "util"

// The pipeline logs every step: tests capture it (quiet output, and lines to
// assert on). TEST_VERBOSE=1 also prints it.
export interface CapturedConsole {
  lines: string[]
  text(): string
  has(needle: string | RegExp): boolean
  // Runs `fn` once, when a line containing `needle` is logged (to inject a
  // fault at a given point of a run).
  onLine(needle: string, fn: () => void): void
  clear(): void
  restore(): void
}

export const captureConsole = (): CapturedConsole => {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  const lines: string[] = []
  let hooks: { needle: string; fn: () => void }[] = []
  const record = (...args: unknown[]) => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 4 }))).join(" ")
    lines.push(line)
    if (process.env.TEST_VERBOSE) original.log(line)
    for (const hook of hooks.filter((h) => line.includes(h.needle))) {
      hooks = hooks.filter((h) => h !== hook)
      hook.fn()
    }
  }
  console.log = record
  console.info = record
  console.warn = record
  console.error = record
  return {
    lines,
    text: () => lines.join("\n"),
    has: (needle) => lines.some((line) => (typeof needle === "string" ? line.includes(needle) : needle.test(line))),
    onLine: (needle, fn) => {
      hooks.push({ needle, fn })
    },
    clear: () => {
      lines.length = 0
      hooks = []
    },
    restore: () => {
      Object.assign(console, original)
    },
  }
}
