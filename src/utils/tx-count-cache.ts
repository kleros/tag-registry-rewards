import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"

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

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// One run at a time: two processes checkpointing into the same files would
// overwrite each other's progress. Returns the release function.
//
// A run never removes another run's lock, not even one left by a run that
// died: two runs starting together could both judge it stale (or catch a new
// lock before its pid is written) and both go on. Ctrl+C and termination
// signals release the lock instead, so only a hard kill leaves one behind,
// and the next run then stops and names the file to delete.
export const acquireTxCountCacheLock = (): (() => void) => {
  if (!txCountCacheEnabled()) return () => undefined
  const dir = txCountCacheDir()
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, ".lock")
  const pidIn = (): number | null => {
    try {
      return Number(readFileSync(lockPath).toString().trim()) || 0
    } catch {
      return null // no lock file
    }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      // "wx" creates the file only if it does not exist yet, atomically.
      writeFileSync(lockPath, String(process.pid), { flag: "wx" })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
    const pid = pidIn()
    if (pid === null && attempt < 3) continue // released in the meantime
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(`[tx-count-cache] Another run (pid ${pid}) is using ${dir}. Wait for it to finish.`)
    }
    throw new Error(
      `[tx-count-cache] ${lockPath} is held by ${pid ? `pid ${pid}, which is no longer running` : "no recorded pid"}: ` +
        `a run was killed before it could release it, or one is starting right now. ` +
        `If no other run is using ${dir}, delete that file and rerun.`
    )
  }
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    for (const signal of signals) process.removeListener(signal, onSignal)
    if (pidIn() !== process.pid) return // never another run's lock
    try {
      unlinkSync(lockPath)
    } catch {
      // already removed
    }
  }
  // Release, then let the signal do what it would have done (end the run).
  function onSignal(signal: NodeJS.Signals): void {
    release()
    process.kill(process.pid, signal)
  }
  for (const signal of signals) process.once(signal, onSignal)
  return release
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
