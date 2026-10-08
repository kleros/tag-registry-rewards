// Runs long, sequential scans (a block range on HyperSync, a signature history
// on Solana) with a fixed number of workers. A scan can only advance one
// request at a time, so when a worker runs out of scans it asks the scan with
// the most remaining work to split itself in two. The owner performs the split
// between two of its own requests, so a range is never scanned twice.

export interface SplittableUnit {
  busy: boolean
  splitRequested: boolean
  isDone(): boolean
  // Estimated requests still needed; 0 when unknown or too small to split.
  remainingWork(): number
}

export const runSplittableWork = async <U extends SplittableUnit>(
  units: U[],
  workers: number,
  step: (unit: U) => Promise<void>,
  split: (unit: U) => Promise<U | null>,
  minSplitWork = 4
): Promise<void> => {
  let failure: unknown = null
  let waiters: (() => void)[] = []
  const notify = () => {
    const pending = waiters
    waiters = []
    for (const wake of pending) wake()
  }
  // Resolves on the next notify(), or after 15 s as a safety net.
  const changed = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(wake, 15000)
      waiters.push(wake)
    })

  const runOwned = async (unit: U) => {
    unit.busy = true
    let steps = 0
    try {
      while (failure === null && !unit.isDone()) {
        await step(unit)
        steps++
        let added = false
        if (unit.splitRequested && !unit.isDone()) {
          const extra = await split(unit)
          if (extra) {
            units.push(extra)
            added = true
          }
        }
        unit.splitRequested = false
        // Idle workers only need waking when there is something new to take
        // (a split) or to split (a first step gives a scan its estimate).
        if (added || steps === 1) notify()
      }
    } finally {
      unit.busy = false
      unit.splitRequested = false
      notify()
    }
  }

  const worker = async () => {
    while (failure === null) {
      const idle = units.find((u) => !u.busy && !u.isDone())
      if (idle) {
        try {
          await runOwned(idle)
        } catch (err) {
          if (failure === null) failure = err
          notify()
        }
        continue
      }
      if (!units.some((u) => u.busy)) return
      let best: U | null = null
      let bestWork = 0
      for (const u of units) {
        if (!u.busy || u.splitRequested || u.isDone()) continue
        const work = u.remainingWork()
        if (work >= minSplitWork && work > bestWork) {
          best = u
          bestWork = work
        }
      }
      if (best) best.splitRequested = true
      await changed()
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()))
  if (failure !== null) throw failure
}
