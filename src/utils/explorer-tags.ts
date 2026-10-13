import { sleep } from "../transaction-sender"
import { httpFetch } from "./http"

// Whether an entry is already tagged on its chain's reference explorer: Address
// Tags and Tokens entries already tagged there are not rewarded (Contract
// Domain Name entries are exempt). Read without any key:
// - Etherscan-built explorers (etherscan.io, basescan.org, arc.etherscan.io…):
//   the address page. Its public name tag carries the tooltip "Public Name Tag
//   (viewable by anyone)"; labels and badges ("Token Contract", "DEX", the
//   EIP-7702 "Authority") share its markup without that tooltip, and are no tag.
// - Blockscout explorers (gnosis, zksync, robinhoodchain): Blockscout's metadata
//   service, the name tags their address pages show. Blockscout also imports
//   Kleros Scout's own entries as name tags: those are not counted, or an
//   accepted entry would disqualify itself once imported.
// - Explorers a script cannot read (arbiscan.io and optimistic.etherscan.io
//   answer with a Cloudflare challenge, Solscan has no keyless way): unknown.
//   Such an entry is never taken for untagged: it is listed for a check by hand.

export interface ExplorerCheck {
  tagged: boolean | null // null: the explorer could not be read
  names: string[] // the name tags that count
  ignored: string[] // name tags not counted (imported from Kleros Scout)
  detail: string
  url: string // the address page, for a check by hand
}

export interface ExplorerItem {
  key: string // the caller's id for it (a tag id)
  host: string // chains.ts explorer
  chainId: string
  address: string
}

const ETHERSCAN_BUILT = new Set([
  "etherscan.io",
  "snowscan.xyz",
  "celoscan.io",
  "basescan.org",
  "lineascan.build",
  "polygonscan.com",
  "mega.etherscan.io",
  "hyperevmscan.io",
  "arc.etherscan.io",
  "arbiscan.io",
  "optimistic.etherscan.io",
])
// gnosis.blockscout.com redirects to gnosisscan.io, which serves the same Blockscout.
const isBlockscout = (host: string): boolean => /\.blockscout\.com$/.test(host) || host === "gnosisscan.io"

const PUBLIC_NAME_TAG = "Public Name Tag (viewable by anyone)"

// One address per explorer known to carry a name tag (all checked 2026-10-13),
// read before the entries: should it not read as tagged, the explorer's page
// or API has changed under this code, and every answer of it is suspect (a
// changed page would read as "no tag" for everyone). Its entries are then all
// "not read", for a check by hand, never silently untagged.
export const CANARIES: { [host: string]: string } = {
  "etherscan.io": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Circle: USDC Token
  "snowscan.xyz": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // USDC
  "celoscan.io": "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO
  "basescan.org": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "lineascan.build": "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", // USDC
  "polygonscan.com": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC
  "mega.etherscan.io": "0x4200000000000000000000000000000000000006", // WETH
  "hyperevmscan.io": "0x5555555555555555555555555555555555555555", // WHYPE
  "arc.etherscan.io": "0x3600000000000000000000000000000000000000", // USDC
  "arbiscan.io": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "optimistic.etherscan.io": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC
  "gnosis.blockscout.com": "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d", // Gnosis: xDai Bridge
  "gnosisscan.io": "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d",
  "zksync.blockscout.com": "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", // WETH
  "robinhoodchain.blockscout.com": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
}

const formatChanged = (host: string, canary: string, result: ExplorerCheck): string =>
  `${host} does not read as expected: ${canary}, which carries a name tag, read as ` +
  (result.tagged === false ? "untagged" : `"${result.detail}"`) +
  " (its pages or API changed, or it failed): check by hand"
const ETHERSCAN_PACE_SECONDS = 2 // between two pages of one host (hosts run side by side)
const BLOCKSCOUT_BATCH = 50
const BLOCKSCOUT_PACE_SECONDS = 1
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

const isEvmAddress = (address: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(address)

export const explorerAddressUrl = (host: string, address: string): string =>
  host === "solscan.io" ? `https://solscan.io/account/${address}` : `https://${host}/address/${address}`

const check = (
  tagged: boolean | null,
  detail: string,
  url: string,
  names: string[] = [],
  ignored: string[] = []
): ExplorerCheck => ({ tagged, names, ignored, detail, url })

const decodeHtml = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()

// An Etherscan-built address page: tagged when it shows a public name tag.
// null when the page is not that address's (a challenge, an error page).
export const parseEtherscanAddressPage = (html: string, address: string, url = ""): ExplorerCheck => {
  const title = decodeHtml(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").replace(/\s+/g, " "))
  if (/Just a moment|Attention Required/i.test(title)) return check(null, "a Cloudflare challenge page", url)
  // "[<tag or ENS name> | ]Address: 0x1234abcd...<end> | <Explorer>"
  if (!/Address:?\s*0x/i.test(title) || !title.toLowerCase().includes(address.slice(0, 10).toLowerCase())) {
    return check(null, `not this address's page ("${title.slice(0, 80)}")`, url)
  }
  if (!html.includes(PUBLIC_NAME_TAG)) return check(false, "no public name tag", url)
  const names: string[] = []
  const re = /Public Name Tag \(viewable by anyone\)[\s\S]{0,600}?<i class=['"]fas fa-tag text-muted['"]><\/i>\s*<span class=['"]hash-tag[^'"]*['"]>([^<]*)<\/span>/g
  for (let m = re.exec(html); m; m = re.exec(html)) names.push(decodeHtml(m[1]))
  return check(true, "public name tag", url, names.length > 0 ? names : ["(name not read)"])
}

interface MetadataTag {
  name: string
  tagType: string
  meta?: string | null
}

const metaOf = (tag: MetadataTag): { [key: string]: unknown } => {
  try {
    const parsed = JSON.parse(tag.meta || "{}")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

// Blockscout's own copy of a Kleros Scout entry. Its link points at the Scout
// item, in either form the service hands out (it varies by request):
// scout-app.kleros.io/single-tags/<item>, or
// app.klerosscout.eth.limo/#/?registry=Single_Tags&itemdetails=<item>@<registry>.
// A tag merely linking to a Kleros website (a Kleros contract's own tag) is a
// tag like any other.
export const isKlerosSourced = (tag: MetadataTag): boolean => {
  const url = String(metaOf(tag).tagUrl || "")
  return /kleros/i.test(url) && /scout|curate|single[_-]?tags|itemdetails/i.test(url)
}

// The metadata service's tags of one address: tagged when a visible name tag
// does not come from Kleros Scout. Other tag types (generic labels such as
// "Token Contract", protocol, classifier, reputation, notes) are no name tags.
export const evaluateBlockscoutTags = (tags: MetadataTag[], url = ""): ExplorerCheck => {
  const visible = tags.filter((t) => t.tagType === "name" && metaOf(t).hidden !== "true" && metaOf(t).hidden !== true)
  const counted = visible.filter((t) => !isKlerosSourced(t))
  const ignored = visible.filter(isKlerosSourced)
  return check(
    counted.length > 0,
    counted.length > 0 ? "name tag" : ignored.length > 0 ? "only name tags imported from Kleros Scout" : "no name tag",
    url,
    counted.map((t) => t.name),
    ignored.map((t) => t.name)
  )
}

const errorText = (err: unknown): string => String((err as Error)?.message || err).slice(0, 160)

// One page of an Etherscan-built host: the check, and whether the host shut
// scripts out (a challenge, or rate limits that did not let up).
const readEtherscanPage = async (host: string, address: string): Promise<{ result: ExplorerCheck; blocked?: string }> => {
  const url = explorerAddressUrl(host, address)
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await httpFetch(url, { headers: BROWSER_HEADERS, timeout: 30000 })
      const html = await res.text()
      if (res.status === 429 && attempt === 1) {
        await sleep(30)
        continue
      }
      if (res.status !== 200) {
        const challenge = res.headers.get("cf-mitigated") === "challenge" || /<title[^>]*>\s*Just a moment/i.test(html)
        const why = challenge ? `${host} shuts scripts out (Cloudflare challenge)` : res.status === 429 ? `${host} rate-limits us` : ""
        return { result: check(null, why || `HTTP ${res.status}`, url), ...(why ? { blocked: why } : {}) }
      }
      if (res.url && res.url.toLowerCase() !== url.toLowerCase()) return { result: check(null, `redirected to ${res.url}`, url) }
      const result = parseEtherscanAddressPage(html, address, url)
      return /Cloudflare/.test(result.detail) ? { result, blocked: `${host} shuts scripts out (Cloudflare challenge)` } : { result }
    } catch (err) {
      if (attempt === 1) {
        await sleep(5)
        continue
      }
      return { result: check(null, `could not load the page: ${errorText(err)}`, url) }
    }
  }
}

// The pages of one host, `canary` first (see CANARIES): once the host shuts
// scripts out, or its canary does not read as tagged, it is not asked again.
const readEtherscanHost = async (host: string, addresses: string[], canary?: string): Promise<Map<string, ExplorerCheck>> => {
  const out = new Map<string, ExplorerCheck>()
  let blocked: string | undefined
  const order = canary ? [canary].concat(addresses.filter((a) => a !== canary)) : addresses
  for (const [i, address] of order.entries()) {
    if (blocked) {
      out.set(address, check(null, blocked, explorerAddressUrl(host, address)))
      continue
    }
    if (i > 0) await sleep(ETHERSCAN_PACE_SECONDS)
    const page = await readEtherscanPage(host, address)
    out.set(address, page.result)
    blocked = page.blocked
    if (!blocked && canary && i === 0 && page.result.tagged !== true) blocked = formatChanged(host, canary, page.result)
  }
  return out
}

const readBlockscoutBatch = async (host: string, chainId: string, addresses: string[]): Promise<Map<string, ExplorerCheck>> => {
  const out = new Map<string, ExplorerCheck>()
  const api = `https://metadata.services.blockscout.com/api/v1/metadata?addresses=${addresses.join(",")}&chainId=${chainId}`
  let failure = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(5)
    try {
      const res = await httpFetch(api, { headers: { Accept: "application/json" }, timeout: 30000 })
      if (res.status !== 200) {
        failure = `Blockscout's metadata service answered HTTP ${res.status}`
        continue
      }
      const body = await res.json()
      if (!body || typeof body.addresses !== "object" || body.addresses === null) {
        failure = "Blockscout's metadata service answered something unexpected"
        continue
      }
      const keys = Object.keys(body.addresses)
      for (const address of addresses) {
        const key = keys.find((k) => k.toLowerCase() === address.toLowerCase())
        const tags: MetadataTag[] = key && Array.isArray(body.addresses[key].tags) ? body.addresses[key].tags : []
        out.set(address, evaluateBlockscoutTags(tags, explorerAddressUrl(host, address)))
      }
      return out
    } catch (err) {
      failure = `Blockscout's metadata service could not be read: ${errorText(err)}`
    }
  }
  for (const address of addresses) out.set(address, check(null, failure, explorerAddressUrl(host, address)))
  return out
}

// Batches of one host, `canary` in the first (see CANARIES): the rest are
// not asked for once it does not read as tagged.
const readBlockscoutHost = async (host: string, chainId: string, addresses: string[], canary?: string): Promise<Map<string, ExplorerCheck>> => {
  const out = new Map<string, ExplorerCheck>()
  const valid = addresses.filter(isEvmAddress)
  for (const address of addresses.filter((a) => !isEvmAddress(a))) {
    out.set(address, check(null, "not an EVM address", explorerAddressUrl(host, address)))
  }
  const order = canary ? [canary].concat(valid.filter((a) => a !== canary)) : valid
  for (let i = 0; i < order.length; i += BLOCKSCOUT_BATCH) {
    if (i > 0) await sleep(BLOCKSCOUT_PACE_SECONDS)
    for (const [address, result] of await readBlockscoutBatch(host, chainId, order.slice(i, i + BLOCKSCOUT_BATCH))) {
      out.set(address, result)
    }
    const canaryResult = canary ? out.get(canary) : undefined
    if (canaryResult && canaryResult.tagged !== true) {
      const why = formatChanged(host, canary as string, canaryResult)
      for (const address of order.slice(i + BLOCKSCOUT_BATCH)) out.set(address, check(null, why, explorerAddressUrl(host, address)))
      break
    }
  }
  return out
}

// Every item checked, keyed by item.key. An address is read once per explorer;
// explorers are read side by side, each at its own pace.
export const checkExplorerTags = async (items: ExplorerItem[]): Promise<Map<string, ExplorerCheck>> => {
  const byHost = new Map<string, { chainId: string; addresses: Map<string, string[]> }>()
  for (const item of items) {
    const host = item.host.toLowerCase()
    const address = isEvmAddress(item.address) ? item.address.toLowerCase() : item.address
    if (!byHost.has(host)) byHost.set(host, { chainId: item.chainId, addresses: new Map() })
    const entry = byHost.get(host) as { chainId: string; addresses: Map<string, string[]> }
    entry.addresses.set(address, (entry.addresses.get(address) || []).concat(item.key))
  }
  const out = new Map<string, ExplorerCheck>()
  await Promise.all(
    Array.from(byHost.entries()).map(async ([host, { chainId, addresses }]) => {
      const list = Array.from(addresses.keys())
      const canary = CANARIES[host] ? CANARIES[host].toLowerCase() : undefined
      let results: Map<string, ExplorerCheck>
      if (isBlockscout(host)) results = await readBlockscoutHost(host, chainId, list, canary)
      else if (ETHERSCAN_BUILT.has(host)) results = await readEtherscanHost(host, list, canary)
      else {
        results = new Map(list.map((a) => [a, check(null, `${host} cannot be read without a key`, explorerAddressUrl(host, a))]))
      }
      // A canary that did not read as tagged discredits every answer of its host.
      const canaryResult = canary ? results.get(canary) : undefined
      const discredited = canaryResult && canaryResult.tagged !== true ? formatChanged(host, canary as string, canaryResult) : ""
      for (const [address, keys] of addresses) {
        const result = discredited
          ? check(null, (results.get(address) as ExplorerCheck).tagged === null ? (results.get(address) as ExplorerCheck).detail : discredited, explorerAddressUrl(host, address))
          : (results.get(address) as ExplorerCheck)
        for (const key of keys) out.set(key, result)
      }
    })
  )
  return out
}
