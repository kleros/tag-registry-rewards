import { readFileSync } from "fs"
import { basename } from "path"

export const IPFS_GATEWAY =
  process.env.IPFS_GATEWAY?.replace(/\/+$/, "") || "https://cdn.kleros.link/ipfs"

export interface IpfsUploadResult {
  cid: string
  url: string
}

// Uploads a file to IPFS via Filebase (same approach as pnk-merkle-drop).
// Returns null when FILEBASE_TOKEN is unset or the client is unavailable, so
// the pipeline still produces the local JSON without a pinning credential.
export const uploadToIpfs = async (
  filePath: string
): Promise<IpfsUploadResult | null> => {
  const token = process.env.FILEBASE_TOKEN
  if (!token) {
    console.warn(
      "[ipfs] FILEBASE_TOKEN not set — skipping upload, wrote local JSON only."
    )
    return null
  }

  let FilebaseClient: any
  let FileCtor: any
  try {
    // Loaded lazily so the mode works even if @filebase/client isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@filebase/client")
    FilebaseClient = mod.FilebaseClient
    FileCtor = mod.File
  } catch {
    console.warn(
      "[ipfs] @filebase/client not installed — run `yarn add @filebase/client`. Wrote local JSON only."
    )
    return null
  }

  try {
    const filebase = new FilebaseClient({ token })
    const content = readFileSync(filePath)
    const fileName = basename(filePath)
    const cid: string = await filebase.storeDirectory([
      new FileCtor([content], fileName, { type: "application/json" }),
    ])
    const url = `${IPFS_GATEWAY}/${cid}/${fileName}`
    return { cid, url }
  } catch (err) {
    console.warn("[ipfs] Upload failed, wrote local JSON only:", err)
    return null
  }
}
