// Small helpers shared by the tx-count providers.

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const errorMessage = (err: unknown): string => String((err as Error)?.message || err)

// Optional wall-clock budget for the tx-count lanes (--max-minutes). Both
// lanes check it before each request, so they stop with every finished page
// checkpointed in the cache and the next run resumes from there.
let deadlineMs = 0

export const setDeadline = (atMs: number): void => {
  deadlineMs = atMs
}

export class BudgetExceededError extends Error {
  constructor() {
    super("time budget reached")
    this.name = "BudgetExceededError"
  }
}

export const isBudgetExceeded = (err: unknown): boolean => err instanceof BudgetExceededError

export const checkDeadline = (): void => {
  if (deadlineMs && Date.now() >= deadlineMs) throw new BudgetExceededError()
}

// Optional non-negative integer setting; throws on anything else so a typo is
// not silently replaced by the default.
export const envInt = (name: string, fallback: number): number => {
  const raw = String(process.env[name] || "").trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}="${raw}": expected a non-negative integer`)
  }
  return value
}

export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Runs `task` over `items` with at most `concurrency` in flight.
export const forEachConcurrent = async <T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()))
}
