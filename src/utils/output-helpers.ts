import { existsSync, mkdirSync } from "fs"
import conf from "../config"
import { Tag } from "../types"

export const ensureFilesDir = (): void => {
  if (!existsSync(`./${conf.FILES_DIR}`)) {
    mkdirSync(`./${conf.FILES_DIR}`, { recursive: true })
  }
}

export const formatRegistry = (value: Tag["registry"]): string => {
  if (value === "addressTags") return "Address Tags"
  if (value === "tokens") return "Kleros Tokens"
  return "Domains"
}
