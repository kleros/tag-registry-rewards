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
    // Loaded lazily so tooling that never uploads doesn't need the package.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@filebase/client")
    FilebaseClient = mod.FilebaseClient
    FileCtor = mod.File
  } catch {
    // A token is configured, so an upload is expected: failing to load the
    // client must not silently degrade into a cid:null index entry.
    throw new Error(
      "[ipfs] FILEBASE_TOKEN is set but @filebase/client is not installed — run `yarn install`."
    )
  }

  const filebase = new FilebaseClient({ token })
  const content = readFileSync(filePath)
  const fileName = basename(filePath)
  // A configured token that fails to upload is an error, not a fallback: the
  // caller would otherwise publish an index entry with cid/url null while the
  // snapshot never reached IPFS. Let the failure propagate (non-zero exit).
  const cid: string = await filebase.storeDirectory([
    new FileCtor([content], fileName, { type: "application/json" }),
  ])
  const url = `${IPFS_GATEWAY}/${cid}/${fileName}`
  return { cid, url }
}
