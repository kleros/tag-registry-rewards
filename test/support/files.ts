import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { gunzipSync } from "zlib"

// Each test process runs in its own temporary directory (test/support/hermetic.js).
export const tmpRoot = (): string => process.env.HERMETIC_TMP || tmpdir()

export const freshDir = (prefix = "case-"): string => mkdtempSync(join(tmpRoot(), prefix))

// A new, empty working directory, like the repo root where the CLI runs:
// files/, exclusions.json and disbursements/ resolve inside it.
export const freshWorkdir = (): string => {
  const dir = freshDir("work-")
  process.chdir(dir)
  return dir
}

export const readJson = <T = any>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T

export const writeJson = (file: string, data: unknown, pretty = true): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data))
}

export const readGzipJson = <T = any>(file: string): T => JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as T

export const listFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

// The one file in `dir` whose name matches, or an error naming what is there.
export const oneFile = (dir: string, pattern: RegExp): string => {
  const matches = listFiles(dir).filter((name) => pattern.test(name))
  if (matches.length !== 1) {
    throw new Error(`expected one file matching ${pattern} in ${dir}, found: ${listFiles(dir).join(", ") || "none"}`)
  }
  return matches[0]
}

export const FIXTURES = join(__dirname, "..", "fixtures")

// Rows of a CSV written by csv-writer (quoted fields may hold commas and "").
export const readCsv = (file: string): string[][] => {
  const rows: string[][] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue
    const fields: string[] = []
    let field = ""
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          field += '"'
          i++
        } else if (ch === '"') quoted = false
        else field += ch
      } else if (ch === '"') quoted = true
      else if (ch === ",") {
        fields.push(field)
        field = ""
      } else field += ch
    }
    fields.push(field)
    rows.push(fields)
  }
  return rows
}
