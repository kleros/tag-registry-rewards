import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// One run at a time per directory (`<dir>/.lock` holds the pid): two
// processes writing the same files would overwrite each other's progress.
// Returns the release function. `label` prefixes the error messages.
//
// A run never removes another run's lock, not even one left by a run that
// died: two runs starting together could both judge it stale (or catch a new
// lock before its pid is written) and both go on. Ctrl+C and termination
// signals release the lock instead, so only a hard kill leaves one behind,
// and the next run then stops and names the file to delete.
export const acquireLockFile = (dir: string, label: string): (() => void) => {
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
      throw new Error(
        `[${label}] Another run (pid ${pid}) is using ${dir}. Wait for it to finish ` +
          `(after a restart that pid can belong to another program: if no run is going on, delete ${lockPath}).`
      )
    }
    throw new Error(
      `[${label}] ${lockPath} is held by ${pid ? `pid ${pid}, which is no longer running` : "no recorded pid"}: ` +
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
