// The pipeline reads its settings from process.env when it runs (src/config.ts
// exports process.env itself), so tests change them around a call.
export type EnvVars = { [key: string]: string | undefined }

// Sets (or, with undefined, deletes) variables; returns a function restoring them.
export const setEnv = (vars: EnvVars): (() => void) => {
  const previous: EnvVars = {}
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  return () => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

export const withEnv = async <T>(vars: EnvVars, fn: () => T | Promise<T>): Promise<T> => {
  const restore = setEnv(vars)
  try {
    return await fn()
  } finally {
    restore()
  }
}
