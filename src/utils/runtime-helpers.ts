// Small helpers shared by the tx-count providers.

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const errorMessage = (err: unknown): string => String((err as Error)?.message || err)

// Optional wall-clock budget for the tx-count lanes (--max-minutes). Both
// lanes check it before each request, so they stop with every finished page
// checkpointed in the cache and the next run resumes from there. The clock
// starts with the counting, not with the tag fetch and filters before it, so
// every run gets its full budget for counting and a rerun always progresses.
let budgetMs = 0
let deadlineMs = 0

export const setTimeBudget = (minutes: number): void => {
  budgetMs = minutes * 60000
}

export const startTimeBudget = (): void => {
  if (budgetMs && !deadlineMs) deadlineMs = Date.now() + budgetMs
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

// The error to report when several tasks failed: a real one before a
// --max-minutes stop, which only means "rerun to continue".
const firstError = (errors: unknown[]): unknown => errors.find((err) => !isBudgetExceeded(err)) || errors[0]

// Waits for every promise, then throws (like runSplittableWork): work already
// running finishes and checkpoints before the caller's cleanup (cache flush,
// lock release) runs, instead of going on behind it. `onError` hears of each
// failure as it happens.
export const settleAll = async <T>(promises: Promise<T>[], onError?: (err: unknown) => void): Promise<T[]> => {
  const errors: unknown[] = []
  const values = await Promise.all(
    promises.map((promise) =>
      promise.catch((err) => {
        errors.push(err)
        if (onError) onError(err)
        return (undefined as unknown) as T
      })
    )
  )
  if (errors.length > 0) throw firstError(errors)
  return values
}

// Runs `task` over `items` with at most `concurrency` in flight. Once a task
// fails no new one starts; the ones already running finish before the error
// is thrown (see settleAll).
export const forEachConcurrent = async <T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let next = 0
  const errors: unknown[] = []
  const worker = async () => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next++]
      try {
        await task(item)
      } catch (err) {
        errors.push(err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()))
  if (errors.length > 0) throw firstError(errors)
}
