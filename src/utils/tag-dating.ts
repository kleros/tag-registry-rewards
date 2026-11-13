import { gunzipSync } from "zlib"
import { sleep } from "../transaction-sender"
import { httpFetch } from "./http"
import { EXPLORER_BROWSER_HEADERS, isEtherscanBuilt, parseArchivedAddressPage } from "./explorer-tags"

// Whether an Address Tags or Tokens entry tagged on its reference explorer
// today (or on an explorer that cannot be read) was already tagged when it was
// submitted, the moment the program's rule is about. Explorers show no date
// for a tag, so an entry is excluded only on dated evidence of the tag itself,
// made outside Kleros, all of it free and public, in this order:
//
//   1. a Wayback Machine copy of its address page taken after the submission
//      shows no public name tag                                   -> kept
//   2. a copy taken before the submission shows the tag           -> excluded
//   3. eth-labels (dawsbot/eth-labels, a public scrape of Etherscan-built
//      explorers' tags kept in git) lists the tag in a copy committed before
//      the submission                                             -> excluded
//   4. the token logo the explorer hosts for it (the tracker's) was written
//      after the submission                                       -> kept
//   5. anything else (no dated evidence, Solscan)                 -> paid by default
//
// A logo written before the submission excludes nothing: it dates the token's
// explorer profile, which can exist without a tag (COMP, TROLL and BabyPepe
// show a logo and no tag), so a tag added to it later would pass for an old
// one.
//
// Failures only ever pay. An exclusion's evidence must stand against what the
// archive holds of the page: 2 and 3 exclude only once the archive answered,
// the earliest copy after the submission (which could keep the entry) was
// read, and no copy before the submission that could show the tag gone was
// left unread or shows it gone: for 2, none newer than the copy with the tag;
// for 3, whose rows carry no date of their own, none at all. An empty answer
// of the index that 3 would rest on (a page never archived, or none of its
// copies before the submission) is checked first against the page's earliest
// copy, asked for in another form, since an answer cut short reads the same
// as none. Both exclude only when the program's registries hold no entry of
// the address that could have given the page its tag: one registered before
// the copy with the tag (2), or before eth-labels' copy or a newer copy
// showing another tag (3), or, when today's page could not be read, any time
// before the submission (the explorer may have put the entry's tag in place
// since; a tag read today is not Kleros's). A tag an explorer took from Kleros
// never counts (explorer-tags.ts reads its note on today's page and on archived
// ones; this covers the pages that cannot be read and layouts without it). An archive
// that does not answer, refuses, or runs out of time leaves the entry paid by
// default, saying so. Every verdict says what it rests on. Nothing is left to
// check by hand.

export type DatingDecision = "excluded" | "kept" | "paid by default"

// A verdict paid by default because the Wayback Machine did not answer,
// refused the run's requests or ran out of time, eth-labels could not be
// read, or the registries could not be read for an earlier Kleros entry: one
// a later run may decide otherwise. The run counts them; the rule pays them.
export const datedUnchecked = (verdict: { decision?: string; evidence?: string }): boolean =>
  verdict.decision === "paid by default" && /the Wayback Machine|could not be checked|eth-labels could not be read/.test(verdict.evidence || "")

export interface DatingItem {
  key: string
  host: string // the chain's reference explorer
  chainId: string
  address: string
  submissionTime?: number // unix s, the registration request's
  // today's reading: tagged (true), or not read (null); one read untagged is kept as is
  tagged: boolean | null
  names?: string[]
  logo?: string
}

export interface DatingVerdict {
  decision: DatingDecision
  evidence: string
}

export interface DatingOptions {
  // An earlier entry of the program's registries for the item's address,
  // registered before `before` (unix s): its description, or null when there
  // is none. Anything else it says (it could not be checked) is a reason not
  // to exclude.
  earlierKlerosEntry: (item: DatingItem, before: number) => Promise<string | null>
  archiveBudgetMs?: number // the archive's time for the whole run (default 30 min)
}

const WAYBACK = "https://web.archive.org"
const ETH_LABELS_COMMITS = "https://api.github.com/repos/dawsbot/eth-labels/commits?path=data/csv/accounts.csv&sha=v1&per_page=1"
const ethLabelsCsv = (sha: string): string => `https://raw.githubusercontent.com/dawsbot/eth-labels/${sha}/data/csv/accounts.csv`
const ethLabelsPage = (sha: string): string => `https://github.com/dawsbot/eth-labels/blob/${sha}/data/csv/accounts.csv`

// The Wayback Machine rate-limits (HTTP 429) and stalls at times: it is asked
// one request at a time, waits as long as it says (Retry-After, up to a
// limit) or backs off, and its index and its pages are each not asked again
// in the run once they failed for ARCHIVE_GIVE_UP_AFTER entries in a row, or
// refused (a 429 without Retry-After is its bot block, "suspected abusive bot
// traffic", which lasts hours and can hit the pages while the index answers),
// or once ARCHIVE_BUDGET_MS is spent.
const ARCHIVE_PACE_SECONDS = 2
const COPY_PACE_SECONDS = 5 // before each archived page downloaded: the requests its bot block watches
const ARCHIVE_BACKOFF_SECONDS = [30, 90] // after a first and a second failure (3 attempts)
const ARCHIVE_MAX_WAIT_SECONDS = 120
const ARCHIVE_TIMEOUT_MS = 45000
const ARCHIVE_GIVE_UP_AFTER = 2
const ARCHIVE_BUDGET_MS = 30 * 60000 // October 2026 had ~70 entries to date, ~5-10 s each
const BUDGET_SPENT = "the Wayback Machine's time budget for the run is spent; not asked again in this run"
// The latest copies of a page asked for at once: all of them for nearly any
// entry, so one request finds the copies on both sides of the submission.
const INDEX_ROWS = 50
const COPIES_TRIED = 3 // per side of the submission: one may be a challenge or another page
const LOGO_PACE_SECONDS = 2
const LOGO_TIMEOUT_MS = 30000
const LOGO_GIVE_UP_AFTER = 3 // failed logos in a row, per explorer

const iso = (unix: number): string => new Date(unix * 1000).toISOString().replace(".000Z", "Z")
const sameTag = (a: string | undefined, b: string | undefined): boolean => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
const isEvmAddress = (address: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(address)
const errorText = (err: unknown): string => String((err as Error)?.message || err).slice(0, 160)

export const waybackTimestamp = (unix: number): string => new Date(unix * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14)
const fromWaybackTimestamp = (ts: string): number =>
  Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14)) / 1000

class ArchiveUnreachable extends Error {}
class ArchiveRefuses extends ArchiveUnreachable {}

// How long the archive asks to wait (Retry-After: seconds or a date), if it says.
const retryAfterSeconds = (header: string | null): number | null => {
  if (!header) return null
  const seconds = /^\s*\d+\s*$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000
  return isNaN(seconds) ? null : Math.max(0, Math.ceil(seconds))
}

// A request to the archive, retried on failures that pass (rate limits, 5xx,
// its "Temporarily Offline" page, the network), never past `deadline` (ms):
// the answer and the URL it came from, or ArchiveUnreachable.
const archiveGet = async (url: string, deadline: number): Promise<{ status: number; text: string; url: string }> => {
  let failure = ""
  let wait = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      if (Date.now() + wait * 1000 >= deadline) break
      await sleep(wait)
    }
    if (Date.now() >= deadline) break
    wait = ARCHIVE_BACKOFF_SECONDS[Math.min(attempt, ARCHIVE_BACKOFF_SECONDS.length - 1)]
    try {
      const res = await httpFetch(url, { headers: EXPLORER_BROWSER_HEADERS, timeout: ARCHIVE_TIMEOUT_MS })
      if (res.status === 429 || res.status >= 500) {
        failure = `HTTP ${res.status}`
        const asked = retryAfterSeconds(res.headers.get("retry-after"))
        if (res.status === 429 && (asked === null || asked > ARCHIVE_MAX_WAIT_SECONDS)) {
          throw new ArchiveRefuses("the Wayback Machine refuses this machine's requests (HTTP 429, flagged as bot traffic)")
        }
        if (asked !== null) wait = Math.min(asked, ARCHIVE_MAX_WAIT_SECONDS)
        continue
      }
      const raw = Buffer.from(await res.arrayBuffer())
      // An archived page can come back still compressed: its stored bytes.
      const text = (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8")
      if (/<title>\s*Internet Archive: Temporarily Offline/i.test(text.slice(0, 3000))) {
        failure = "Temporarily Offline"
        continue
      }
      return { status: res.status, text, url: res.url || url }
    } catch (err) {
      if (err instanceof ArchiveRefuses) throw err
      failure = errorText(err)
    }
  }
  throw new ArchiveUnreachable(failure ? `the Wayback Machine did not answer (${failure})` : "the Wayback Machine's time budget for the run is spent")
}

interface Copy {
  at: number // unix s
  timestamp: string
  original: string
}

// The archive's index of an address page (any letter case, http or https):
// its copies answered with HTTP 200, in time order. `window`: CDX parameters
// (to, limit; a negative limit keeps the latest).
const archivedCopies = async (host: string, address: string, window: string, deadline: number): Promise<Copy[]> => {
  const url = `${WAYBACK}/cdx/search/cdx?url=${host}/address/${address}&output=json&fl=timestamp,original&filter=statuscode:200&${window}`
  const { status, text } = await archiveGet(url, deadline)
  if (status !== 200) throw new ArchiveUnreachable(`the Wayback Machine's index answered HTTP ${status}`)
  const body = text.trim()
  if (!body) return []
  let rows: unknown
  try {
    rows = JSON.parse(body)
  } catch {
    throw new ArchiveUnreachable("the Wayback Machine's index answered something unexpected")
  }
  if (!Array.isArray(rows)) throw new ArchiveUnreachable("the Wayback Machine's index answered something unexpected")
  return rows
    .slice(1) // the header row
    .filter((r): r is [string, string] => Array.isArray(r) && /^\d{14}$/.test(String(r[0])) && typeof r[1] === "string")
    .map(([timestamp, original]) => ({ at: fromWaybackTimestamp(timestamp), timestamp, original }))
}

interface ArchivedReading {
  at: number
  url: string // the copy, for anyone to look at
  tagged: boolean
  names: string[]
}

// The first of `copies` that is a copy of this address's page, read strictly.
// A copy the archive redirects to another moment's is not that copy, nor one
// it no longer has (404); any other answer is the archive failing.
const firstReadable = async (copies: Copy[], address: string, deadline: number): Promise<ArchivedReading | null> => {
  for (const copy of copies.slice(0, COPIES_TRIED)) {
    await sleep(COPY_PACE_SECONDS)
    const { status, text, url } = await archiveGet(`${WAYBACK}/web/${copy.timestamp}id_/${copy.original}`, deadline)
    if (status === 404) continue
    if (status !== 200) throw new ArchiveUnreachable(`the Wayback Machine answered HTTP ${status} for a copy`)
    if (!url.includes(`/web/${copy.timestamp}id_/`)) continue
    const page = parseArchivedAddressPage(text, address)
    if (!page.readable) continue
    return { at: copy.at, url: `${WAYBACK}/web/${copy.timestamp}/${copy.original}`, tagged: page.tagged, names: page.names }
  }
  return null
}

// What the archive holds of an item's page around its submission.
interface ArchiveFindings {
  answered: boolean // its index answered: the page's copies are known
  failure: string // why it was not asked, or why copies it holds could not be read ("" when all needed were)
  copies: number
  after: ArchivedReading | null // the earliest readable copy taken after the submission
  afterUnread: boolean // it holds copies after the submission, none of which could be read
  afterSkippedAt: number | null // its earliest copy after the submission, when a later one was read instead
  before: ArchivedReading | null // the latest one taken before it (read unless `after` shows no tag)
  beforeUnreadAt: number | null // its newest copy before the submission, when that one could not be read
  // An empty answer of the index where 3 needs to know there is no copy: of
  // the page at all ("all": never archived) or before the submission
  // ("before", asked apart), to check before eth-labels excludes.
  emptyAnswer: "all" | "before" | null
  // The copies the verdict names when they could not be read here: the
  // newest before the submission and the earliest after it, from the index.
  links: string[]
}

// Where anyone sees every copy the archive holds of a page.
const archiveCalendar = (host: string, address: string): string => `${WAYBACK}/web/*/https://${host}/address/${address}`
const copyLink = (copy: Copy): string => `${WAYBACK}/web/${copy.timestamp}/${copy.original}`

// When the explorer wrote a logo file (its Last-Modified), why it gave none,
// or why it could not be asked.
type LogoDate = { at: number } | { none: string } | { failed: string }
const logoWrittenAt = async (logo: string): Promise<LogoDate> => {
  let failure = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await httpFetch(logo, { method: "HEAD", headers: EXPLORER_BROWSER_HEADERS, timeout: LOGO_TIMEOUT_MS })
      if (res.status === 200) {
        const written = Date.parse(res.headers.get("last-modified") || "")
        return isNaN(written) ? { none: "no Last-Modified" } : { at: Math.floor(written / 1000) }
      }
      if (res.status !== 429 && res.status < 500) return { none: `HTTP ${res.status}` }
      failure = `HTTP ${res.status}`
    } catch (err) {
      failure = errorText(err)
    }
    if (attempt === 1) await sleep(5)
  }
  return { failed: failure }
}

// One line of a CSV with quoted fields ("a ""b""",1 -> [a "b", 1]).
const csvFields = (line: string): string[] => {
  const out: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      out.push(field)
      field = ""
    } else field += c
  }
  out.push(field)
  return out
}

// eth-labels' accounts.csv (address, chainId, label, nameTag): the public name
// tags it lists, keyed "<chainId>:<lowercase address>".
export const parseEthLabelsCsv = (text: string): Map<string, string> => {
  const lines = text.split(/\r?\n/)
  const header = csvFields(lines[0] || "").map((h) => h.trim())
  const [address, chainId, nameTag] = ["address", "chainId", "nameTag"].map((h) => header.indexOf(h))
  if (address < 0 || chainId < 0 || nameTag < 0) throw new Error(`unexpected columns (${header.join(", ").slice(0, 80)})`)
  const tags = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const fields = csvFields(line)
    const name = (fields[nameTag] || "").trim()
    if (name) tags.set(`${(fields[chainId] || "").trim()}:${(fields[address] || "").trim().toLowerCase()}`, name)
  }
  return tags
}

interface EthLabels {
  sha: string
  at: number // when that copy was committed: its tags existed by then
  tags: Map<string, string>
}

// eth-labels' latest copy of its tags, or why it could not be read.
const loadEthLabels = async (): Promise<EthLabels | string> => {
  try {
    const res = await httpFetch(ETH_LABELS_COMMITS, { headers: { ...EXPLORER_BROWSER_HEADERS, Accept: "application/vnd.github+json" }, timeout: 30000 })
    if (res.status !== 200) return `GitHub answered HTTP ${res.status}`
    const commits = await res.json()
    const latest = Array.isArray(commits) ? commits[0] : undefined
    const sha = String(latest?.sha || "")
    const committed = Date.parse(String(latest?.commit?.committer?.date || ""))
    if (!/^[0-9a-f]{40}$/.test(sha) || isNaN(committed)) return "GitHub answered something unexpected"
    const csv = await httpFetch(ethLabelsCsv(sha), { headers: EXPLORER_BROWSER_HEADERS, timeout: 120000, size: 64 * 1024 * 1024 })
    if (csv.status !== 200) return `its file answered HTTP ${csv.status}`
    return { sha, at: Math.floor(committed / 1000), tags: parseEthLabelsCsv(await csv.text()) }
  } catch (err) {
    return errorText(err)
  }
}

// Each item's verdict, keyed by item.key. Items read untagged today get none:
// they are kept as they are. The archive and the logos are asked one request
// at a time; what stops answering, refuses, or runs out of time is not asked
// again in the run (its items are then paid by default, saying so).
export const dateExplorerTags = async (items: DatingItem[], options: DatingOptions): Promise<Map<string, DatingVerdict>> => {
  const out = new Map<string, DatingVerdict>()
  const toDate = items.filter((item) => item.tagged !== false)
  if (toDate.length === 0) return out
  const archiveBudgetMs = options.archiveBudgetMs ?? ARCHIVE_BUDGET_MS
  let archiveDeadline: number | undefined // from the archive's first request
  const budgetSpent = (): boolean => archiveDeadline !== undefined && Date.now() >= archiveDeadline
  let indexDown = ""
  let indexFailures = 0
  let pagesDown = ""
  let pageFailures = 0
  const logosDown = new Map<string, string>() // per explorer
  const logoFailures = new Map<string, number>()
  let ethLabels: EthLabels | string | undefined // read on first need

  const askArchive = async (item: DatingItem, sub: number): Promise<ArchiveFindings> => {
    const unanswered = (failure: string): ArchiveFindings => ({
      answered: false,
      failure,
      copies: 0,
      after: null,
      afterUnread: false,
      afterSkippedAt: null,
      before: null,
      beforeUnreadAt: null,
      emptyAnswer: null,
      links: [archiveCalendar(item.host, item.address)],
    })
    if (indexDown) return unanswered(indexDown)
    if (archiveDeadline === undefined) archiveDeadline = Date.now() + archiveBudgetMs
    const deadline = archiveDeadline
    let after: Copy[]
    let before: Copy[]
    let emptyAnswer: "all" | "before" | null = null
    try {
      // one request finds the copies on both sides of the submission, unless
      // the page has more copies than an answer holds, all after it: then the
      // earliest after it (the answer kept only the latest) and the latest
      // before it are asked for apart
      await sleep(ARCHIVE_PACE_SECONDS)
      const copies = await archivedCopies(item.host, item.address, `limit=-${INDEX_ROWS}`, deadline)
      after = copies.filter((c) => c.at > sub) // the earliest first
      before = copies.filter((c) => c.at < sub).reverse() // the latest first
      if (copies.length === 0) emptyAnswer = "all"
      if (copies.length >= INDEX_ROWS && before.length === 0) {
        await sleep(ARCHIVE_PACE_SECONDS)
        after = (await archivedCopies(item.host, item.address, `from=${waybackTimestamp(sub + 1)}&limit=${COPIES_TRIED}`, deadline)).filter(
          (c) => c.at > sub
        )
        // the first answer listed copies after the submission: none now is the index failing
        if (after.length === 0) throw new ArchiveUnreachable("the Wayback Machine's index gave no copy after the submission when asked for the earliest")
        await sleep(ARCHIVE_PACE_SECONDS)
        before = (await archivedCopies(item.host, item.address, `to=${waybackTimestamp(sub - 1)}&limit=-${COPIES_TRIED}`, deadline)).reverse()
        if (before.length === 0) emptyAnswer = "before"
      }
      indexFailures = 0
    } catch (err) {
      if (!(err instanceof ArchiveUnreachable)) throw err
      if (++indexFailures >= ARCHIVE_GIVE_UP_AFTER || err instanceof ArchiveRefuses || budgetSpent()) {
        indexDown = budgetSpent() ? BUDGET_SPENT : `${err.message}; not asked again in this run`
        console.warn(`[explorer-dating] ${indexDown}`)
      }
      return unanswered(err.message)
    }
    const findings: ArchiveFindings = {
      answered: true,
      failure: "",
      copies: after.length + before.length,
      after: null,
      afterUnread: false,
      afterSkippedAt: null,
      before: null,
      beforeUnreadAt: null,
      emptyAnswer,
      links: [before[0], after[0]].filter((copy): copy is Copy => copy !== undefined).map(copyLink),
    }
    if (findings.copies === 0) return findings
    if (pagesDown) return { ...findings, failure: pagesDown }
    try {
      findings.after = await firstReadable(after, item.address, deadline)
      findings.afterUnread = after.length > 0 && !findings.after
      findings.afterSkippedAt = findings.after && findings.after.at > after[0].at ? after[0].at : null
      if (!findings.after || findings.after.tagged) {
        findings.before = await firstReadable(before, item.address, deadline)
        const newest = before.length > 0 ? before[0].at : null
        findings.beforeUnreadAt = newest !== null && (!findings.before || findings.before.at < newest) ? newest : null
      }
      pageFailures = 0
      return findings
    } catch (err) {
      if (!(err instanceof ArchiveUnreachable)) throw err
      if (++pageFailures >= ARCHIVE_GIVE_UP_AFTER || err instanceof ArchiveRefuses || budgetSpent()) {
        pagesDown = budgetSpent() ? BUDGET_SPENT : `${err.message}; its pages not asked again in this run`
        console.warn(`[explorer-dating] ${pagesDown}`)
      }
      return { ...findings, failure: err.message }
    }
  }

  const askLogo = async (item: DatingItem, logo: string): Promise<{ at: number } | { note: string }> => {
    const down = logosDown.get(item.host)
    if (down) return { note: down }
    await sleep(LOGO_PACE_SECONDS)
    const answer = await logoWrittenAt(logo)
    if ("at" in answer) {
      logoFailures.set(item.host, 0)
      return answer
    }
    if ("none" in answer) {
      logoFailures.set(item.host, 0)
      return { note: `its token logo gave no date (${answer.none})` }
    }
    const failures = (logoFailures.get(item.host) || 0) + 1
    logoFailures.set(item.host, failures)
    if (failures >= LOGO_GIVE_UP_AFTER) {
      logosDown.set(item.host, `${item.host}'s token logos did not answer (${answer.failed}); not asked again in this run`)
      console.warn(`[explorer-dating] ${logosDown.get(item.host)}`)
    }
    return { note: `its token logo could not be read (${answer.failed})` }
  }

  // An empty answer of the index is all eth-labels would be checked against
  // (`empty`: no copy of the page at all, or none before the submission
  // `sub`). Before it excludes, the index is asked in another form for the
  // page's earliest copy, since an answer cut short reads the same as none.
  // Why that contradicts the empty answer, or null.
  const confirmEmptyAnswer = async (item: DatingItem, sub: number, empty: "all" | "before"): Promise<string | null> => {
    const failed = (why: string): string => `the Wayback Machine could not be asked again for the page's copies (${why})`
    if (indexDown) return failed(indexDown)
    try {
      await sleep(ARCHIVE_PACE_SECONDS)
      const earliest = await archivedCopies(item.host, item.address, "limit=1", archiveDeadline as number)
      // "before" follows an answer that listed copies after the submission:
      // no earliest copy at all contradicts it too
      if (empty === "before" && earliest.length === 0) return "the Wayback Machine's index listed no copy of the page when asked again"
      const contradicts = empty === "all" ? earliest.length > 0 : earliest.some((c) => c.at < sub)
      return contradicts ? "the Wayback Machine's index listed copies of the page when asked again" : null
    } catch (err) {
      if (!(err instanceof ArchiveUnreachable)) throw err
      if (err instanceof ArchiveRefuses || budgetSpent()) {
        indexDown = budgetSpent() ? BUDGET_SPENT : `${err.message}; not asked again in this run`
        console.warn(`[explorer-dating] ${indexDown}`)
      }
      return failed(err.message)
    }
  }

  const dateOne = async (item: DatingItem): Promise<DatingVerdict> => {
    const sub = item.submissionTime
    const today = item.tagged === true ? `tagged today (${(item.names || []).join("; ") || "name not read"})` : "its explorer could not be read"
    if (!sub) return { decision: "paid by default", evidence: `${today}; the indexer gave no submission time to compare with` }
    // Solscan, and a Blockscout explorer that did not answer: nothing to date with
    if (!isEvmAddress(item.address) || (!isEtherscanBuilt(item.host) && item.tagged === null)) {
      return { decision: "paid by default", evidence: `${today}, and ${item.host} keeps no dated copy a script can read` }
    }
    const notes: string[] = []
    let unconfirmedEvidence = false // of a tag before the submission
    const archive = isEtherscanBuilt(item.host) ? await askArchive(item, sub) : null

    // Why evidence of the tag before the submission cannot exclude against
    // the archive, or null: the archive must have answered, its earliest copy
    // after the submission (which could keep the entry) been read, and none
    // of its copies before the submission taken from `since` on (from any
    // date when `since` is null: evidence with no date of its own) left
    // unread or showing the page without a tag.
    const unconfirmed = (since: number | null): string | null => {
      if (!archive) return null
      if (!archive.answered) return `the Wayback Machine could not be asked to confirm it (${archive.failure})`
      if (archive.failure) return `the Wayback Machine's copies of the page could not be read to confirm it (${archive.failure})`
      if (archive.afterUnread) return "the page's archived copies after the submission could not be read"
      if (archive.afterSkippedAt !== null) {
        return `the page's archived copy of ${iso(archive.afterSkippedAt)}, after the submission, could not be read`
      }
      const when = since === null ? "before the submission" : "after that"
      if (archive.beforeUnreadAt !== null && (since === null || archive.beforeUnreadAt >= since)) {
        return `the page's archived copy of ${iso(archive.beforeUnreadAt)}, ${when}, could not be read`
      }
      if (archive.before && !archive.before.tagged && (since === null || archive.before.at >= since)) {
        return `the page was archived without a public name tag on ${iso(archive.before.at)}, ${when}`
      }
      return null
    }

    if (archive) {
      if (archive.after && !archive.after.tagged) {
        return { decision: "kept", evidence: `archived without a public name tag on ${iso(archive.after.at)}, after the submission (${iso(sub)}): ${archive.after.url}` }
      }
      if (archive.before && archive.before.tagged) {
        const tag = `the public name tag "${archive.before.names[0]}" on ${iso(archive.before.at)}`
        // a Kleros entry registered since could have given the page its tag
        // by the submission, unless today's page shows a tag not from Kleros
        const klerosCutoff = item.tagged === true ? archive.before.at : sub
        const why = unconfirmed(archive.before.at) || (await options.earlierKlerosEntry(item, klerosCutoff))
        if (!why) {
          return { decision: "excluded", evidence: `archived with ${tag}, before the submission (${iso(sub)}): ${archive.before.url}` }
        }
        notes.push(`archived with ${tag}, but ${why}`)
        unconfirmedEvidence = true
      } else if (!archive.answered) notes.push(archive.failure)
      else if (archive.failure) notes.push(`its archived copies could not be read (${archive.failure})`)
      else if (archive.copies === 0) notes.push("never archived")
      else if (archive.before) notes.push(`archived without a public name tag on ${iso(archive.before.at)}, before the submission`)
      else notes.push("no readable archived copy before the submission")
    }

    if (isEtherscanBuilt(item.host)) {
      if (ethLabels === undefined) {
        ethLabels = await loadEthLabels()
        if (typeof ethLabels === "string") console.warn(`[explorer-dating] eth-labels could not be read: ${ethLabels}`)
      }
      if (typeof ethLabels === "string") notes.push(`eth-labels could not be read (${ethLabels})`)
      else {
        const name = ethLabels.tags.get(`${item.chainId}:${item.address.toLowerCase()}`)
        if (name && ethLabels.at < sub) {
          const listed = `eth-labels lists the public name tag "${name}" in its copy of ${iso(ethLabels.at)}`
          // Its rows carry no date of their own (its puller keeps a row from
          // whichever scrape first saw the tag, years before that copy at
          // times): any copy before the submission without the tag, or
          // unread, stands against it. So does a Kleros entry of the address
          // that could have given the page its tag by the submission: one
          // registered before eth-labels' copy (the listed tag's possible
          // source); one registered before the newest copy before the
          // submission when that copy shows another tag (which may be the
          // entry's); and, when today's page could not be read, one
          // registered any time before the submission (the explorer may have
          // put the entry's tag in the listed one's place). A tag read on
          // today's page is not Kleros's (explorer-tags.ts reads its note).
          const before = archive && archive.before
          const otherTagAt = before && before.tagged && !sameTag(before.names[0], name) ? before.at : 0
          const klerosCutoff = item.tagged === true ? Math.max(ethLabels.at, otherTagAt) : sub
          const why =
            unconfirmed(null) ||
            (archive && archive.emptyAnswer !== null ? await confirmEmptyAnswer(item, sub, archive.emptyAnswer) : null) ||
            (await options.earlierKlerosEntry(item, klerosCutoff))
          if (!why) return { decision: "excluded", evidence: `${listed}, before the submission (${iso(sub)}): ${ethLabelsPage(ethLabels.sha)}` }
          notes.push(`${listed}, but ${why}`)
          unconfirmedEvidence = true
        }
      }
    }

    if (item.tagged === true && item.logo) {
      const logo = await askLogo(item, item.logo)
      if ("note" in logo) notes.push(logo.note)
      else if (logo.at < sub) notes.push(`its token logo was written ${iso(logo.at)}, before the submission (which dates its profile, not its tag)`)
      else {
        // a copy before the submission showing the tag, or eth-labels, would
        // have excluded it: kept only once both could say there is none, and
        // no other evidence of the tag before the submission is unconfirmed
        const why =
          archive && (!archive.answered || archive.failure)
            ? `the Wayback Machine could not be asked about earlier copies (${archive.failure})`
            : archive && archive.beforeUnreadAt !== null
            ? `the page's archived copy of ${iso(archive.beforeUnreadAt)}, before the submission, could not be read`
            : typeof ethLabels === "string"
            ? "eth-labels could not be read"
            : unconfirmedEvidence
            ? "the evidence of a tag before the submission above could not be confirmed"
            : null
        if (!why) return { decision: "kept", evidence: `its token logo ${item.logo} was written ${iso(logo.at)}, after the submission (${iso(sub)})` }
        notes.push(`its token logo was written ${iso(logo.at)}, after the submission, but ${why}`)
      }
    }
    // The archive did not answer here: the copies its verdict could rest on.
    const links = archive && (!archive.answered || archive.failure) && archive.links.length > 0 ? `; archived copies: ${archive.links.join(" , ")}` : ""
    return {
      decision: "paid by default",
      evidence: `${today}, with no dated evidence of a tag at the submission (${iso(sub)})${notes.length ? `: ${notes.join("; ")}` : ""}${links}`,
    }
  }

  for (const item of toDate) out.set(item.key, await dateOne(item))
  return out
}
