import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import { acquireLockFile } from "./lock-file"

// Lifetime transaction counts only ever grow, so they are cached between runs:
// a later run only scans what happened since the cached cutoff. The same files
// checkpoint scans that are still in progress, so an interrupted fetch resumes
// where it stopped instead of starting over.
//
// Kept OUTSIDE files/ on purpose (that folder gets cleaned between runs).
// Default ~/.cache/tag-registry-rewards/tx-counts, override with
// TX_COUNT_CACHE_DIR. TX_COUNT_CACHE=off recounts everything from scratch and
// persists nothing (no resume).

export const txCountCacheEnabled = (): boolean =>
  !/^(off|false|0|no)$/i.test(String(process.env.TX_COUNT_CACHE || "").trim())

export const txCountCacheDir = (): string => {
  const raw = String(process.env.TX_COUNT_CACHE_DIR || "").trim()
  if (!raw) return join(homedir(), ".cache", "tag-registry-rewards", "tx-counts")
  return resolve(raw.replace(/^~(?=$|[/\\])/, homedir()))
}

export const readCacheFile = <T>(name: string): T | null => {
  if (!txCountCacheEnabled()) return null
  const path = join(txCountCacheDir(), name)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path).toString()) as T
  } catch (err) {
    throw new Error(
      `[tx-count-cache] ${path} is not valid JSON (${err}). Fix it, or delete it to recount from scratch.`
    )
  }
}

// Write to a temp file and rename, so a crash mid-write never leaves a
// truncated cache behind.
export const writeCacheFile = (name: string, data: unknown): void => {
  if (!txCountCacheEnabled()) return
  const dir = txCountCacheDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, path)
}

// One run at a time: two processes checkpointing into the same files would
// overwrite each other's progress (see acquireLockFile). Returns the release
// function.
export const acquireTxCountCacheLock = (): (() => void) => {
  if (!txCountCacheEnabled()) return () => undefined
  return acquireLockFile(txCountCacheDir(), "tx-count-cache")
}

// Coalesces frequent checkpoint writes: at most one write per `minIntervalMs`
// per key, plus an explicit flush at the end.
export class ThrottledWriter {
  private lastWrite: { [key: string]: number } = {}
  private pending: { [key: string]: () => unknown } = {}

  constructor(private readonly minIntervalMs: number) {}

  write(key: string, fileName: string, build: () => unknown): void {
    this.pending[key] = () => writeCacheFile(fileName, build())
    const now = Date.now()
    if (now - (this.lastWrite[key] || 0) >= this.minIntervalMs) this.flushKey(key)
  }

  flush(): void {
    for (const key of Object.keys(this.pending)) this.flushKey(key)
  }

  private flushKey(key: string): void {
    const job = this.pending[key]
    if (!job) return
    delete this.pending[key]
    this.lastWrite[key] = Date.now()
    job()
  }
}
