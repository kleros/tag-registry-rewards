import { afterEach, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { gzipSync } from "zlib"
import { dateExplorerTags, datedUnchecked, DatingItem, DatingOptions, parseEthLabelsCsv, waybackTimestamp } from "../../src/utils/tag-dating"

// The dated explorer check against answers shaped like the Wayback Machine's,
// the explorers' and GitHub's (2026-11-11). Its HTTP and pauses are swapped
// through their modules' exports (CommonJS reads them at call time).
const http = require("../../src/utils/http")
const sender = require("../../src/transaction-sender")

const ADDRESS = "0xfbd5fd3f85e9f4c5e8b40eec9f8b8ab1caaa146b"
const SUBMITTED = Date.parse("2026-10-04T14:33:00Z") / 1000
const DAY = 86400
const unixOf = (iso: string) => Date.parse(iso) / 1000
const LOGO = "https://etherscan.io/token/images/treattoken_32.png"

// An archived copy of the address page: tagged or not
const archivedPage = (tagged: boolean, address = ADDRESS, name = "Treat: TREAT Token") =>
  `<html><head><title>${tagged ? `${name} | ` : ""}Address: ${address.slice(0, 10)}...${address.slice(-9)} | Etherscan</title></head><body>` +
  (tagged
    ? `<a href='https://treattoken.org/' title='Public Name Tag (viewable by anyone) <br/> ${name}&#10;(${address})'><div class='d-flex align-items-center gap-1'>` +
      `<i class='fas fa-tag text-muted'></i><span class='hash-tag text-truncate lh-sm my-n1'>${name}</span></div></a>`
    : "") +
  "</body></html>"
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body></body></html>"

type Reply = { status?: number; body?: string | Buffer; headers?: { [h: string]: string }; url?: string } | Error

describe("tag dating: whether a tag seen today was already there at the submission", () => {
  let route: (url: string, method: string) => Reply
  let requests: { url: string; method: string }[]
  let slept: number[]
  let realFetch: unknown
  let realSleep: unknown
  // what the archive holds of each address page: [ISO time, tagged | "challenge"]
  let copies: { [address: string]: [string, boolean | "challenge"][] }
  let archiveDown: boolean
  let logos: { [url: string]: string | null } // Last-Modified
  let ethLabels: { committed: string; csv: string } | null
  // the program's earlier entries of an address, as the filter would describe them
  let earlier: (item: DatingItem, before: number) => string | null
  let earlierAsked: { address: string; before: number }[]

  const cdxRows = (address: string, query: URLSearchParams): string => {
    const all = (copies[address.toLowerCase()] || [])
      .map(([iso, state]) => ({ ts: waybackTimestamp(unixOf(iso)), state }))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    const from = query.get("from")
    const to = query.get("to")
    const limit = Number(query.get("limit"))
    let rows = all.filter((c) => (!from || c.ts >= from) && (!to || c.ts <= to))
    rows = limit < 0 ? rows.slice(limit) : rows.slice(0, limit)
    if (rows.length === 0) return "[]"
    return JSON.stringify([["timestamp", "original"], ...rows.map((c) => [c.ts, `https://etherscan.io/address/${address}`])])
  }

  beforeEach(() => {
    requests = []
    copies = {}
    archiveDown = false
    logos = {}
    ethLabels = { committed: "2026-07-10T16:37:25Z", csv: "address,chainId,label,nameTag\n" } // lists nothing
    earlier = () => null
    earlierAsked = []
    realFetch = http.httpFetch
    realSleep = sender.sleep
    slept = []
    sender.sleep = async (seconds: number) => {
      slept.push(seconds)
    }
    route = (url, method) => {
      const parsed = new URL(url)
      if (parsed.host === "web.archive.org") {
        if (archiveDown) return { status: 503, body: "<html><head><title>Internet Archive: Temporarily Offline</title></head></html>" }
        if (parsed.pathname === "/cdx/search/cdx") {
          const address = (/address\/(0x[0-9a-fA-F]{40})/.exec(parsed.searchParams.get("url") || "") as RegExpExecArray)[1]
          assert.equal(parsed.searchParams.get("filter"), "statuscode:200", "only copies the archive got with HTTP 200")
          return { body: cdxRows(address, parsed.searchParams) }
        }
        const m = /^\/web\/(\d{14})id_\/https:\/\/etherscan\.io\/address\/(0x[0-9a-fA-F]{40})$/.exec(parsed.pathname)
        if (!m) return { status: 404, body: "not archived" }
        const hit = (copies[m[2].toLowerCase()] || []).find(([iso]) => waybackTimestamp(unixOf(iso)) === m[1])
        if (!hit) return { status: 404, body: "not archived" }
        if (hit[1] === "challenge") return { body: CHALLENGE }
        return { body: gzipSync(Buffer.from(archivedPage(hit[1], m[2]))) } // stored compressed, as the archive hands some back
      }
      if (/\/token\/images\//.test(parsed.pathname)) {
        assert.equal(method, "HEAD")
        const written = logos[url]
        return written ? { headers: { "last-modified": new Date(written).toUTCString() } } : { status: 404 }
      }
      if (parsed.host === "api.github.com") {
        if (!ethLabels) return { status: 403, body: "rate limited" }
        return { body: JSON.stringify([{ sha: "a".repeat(40), commit: { committer: { date: ethLabels.committed } } }]) }
      }
      if (parsed.host === "raw.githubusercontent.com" && ethLabels) return { body: ethLabels.csv }
      throw new Error(`unexpected request ${url}`)
    }
    http.httpFetch = async (url: string, init: { method?: string } = {}) => {
      const method = init.method || "GET"
      requests.push({ url, method })
      const reply = route(url, method)
      if (reply instanceof Error) throw reply
      const body = reply.body === undefined ? "" : reply.body
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
      return {
        status: reply.status || 200,
        url: reply.url || url,
        headers: { get: (h: string) => (reply.headers || {})[h.toLowerCase()] || null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => bytes.toString("utf8"),
        json: async () => JSON.parse(bytes.toString("utf8")),
      }
    }
  })
  afterEach(() => {
    http.httpFetch = realFetch
    sender.sleep = realSleep
  })

  const date = (items: DatingItem[], options: Partial<DatingOptions> = {}) =>
    dateExplorerTags(items, {
      earlierKlerosEntry: async (item, before) => {
        earlierAsked.push({ address: item.address, before })
        return earlier(item, before)
      },
      ...options,
    })
  const item = (overrides: Partial<DatingItem> = {}): DatingItem => ({
    key: "a",
    host: "etherscan.io",
    chainId: "1",
    address: ADDRESS,
    submissionTime: SUBMITTED,
    tagged: true,
    names: ["Treat: TREAT Token"],
    ...overrides,
  })
  // a token whose page shows its logo, written in 2025 by the explorer
  const token = (overrides: Partial<DatingItem> = {}): DatingItem => {
    logos[LOGO] = "2025-05-01T00:00:00Z"
    return item({ logo: LOGO, ...overrides })
  }
  // eth-labels listing ADDRESS's tag, in its copy of 2026-07-10
  const listed = () => {
    ethLabels = { committed: "2026-07-10T16:37:25Z", csv: `address,chainId,label,nameTag\n"${ADDRESS}",1,"treat","Treat: TREAT Token"\n` }
  }
  const asked = (host: string) => requests.filter((r) => new URL(r.url).host === host).length

  it("keeps an entry archived without its tag after the submission, asking nothing more", async () => {
    copies[ADDRESS] = [["2026-01-29T05:09:03Z", true], ["2026-10-05T10:00:00Z", false]]
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "kept")
    assert.match(verdict.evidence, /^archived without a public name tag on 2026-10-05T10:00:00Z, after the submission \(2026-10-04T14:33:00Z\): https:\/\/web\.archive\.org\/web\/20261005100000\//)
    assert.equal(asked("etherscan.io") + asked("api.github.com"), 0, "the copy after the submission settles it: neither its logo nor eth-labels")
  })

  it("excludes an entry archived with its tag before the submission, reading compressed copies", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-10-20T00:00:00Z", true]]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "excluded")
    assert.equal(
      verdict.evidence,
      `archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, before the submission (2026-10-04T14:33:00Z): ` +
        `https://web.archive.org/web/20250116091735/https://etherscan.io/address/${ADDRESS}`
    )
    assert.deepEqual(earlierAsked, [{ address: ADDRESS, before: unixOf("2025-01-16T09:17:35Z") }], "no earlier Kleros entry of the address was asked about first")
  })

  it("does not exclude on an archived tag when the earliest copy after the submission could not be read (it might have kept the entry)", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-10-10T00:00:00Z", "challenge"], ["2026-10-20T00:00:00Z", true]]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(
      verdict.evidence,
      /archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, but the page's archived copy of 2026-10-10T00:00:00Z, after the submission, could not be read/
    )
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-10-10T00:00:00Z", false], ["2026-10-20T00:00:00Z", true]]
    assert.equal((await date([item()])).get("a")!.decision, "kept", "read, that copy keeps it")
  })

  it("does not hold against an entry a tag an earlier Kleros entry of its address may have given it", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true]]
    earlier = () => "Kleros entry 0x01@0x66 registered this address on 2024-03-01T00:00:00.000Z, and a tag an explorer took from Kleros never counts"
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(verdict.evidence, /archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, but Kleros entry 0x01@0x66 registered this address/)
  })

  it("skips a copy the archive redirects to another moment's", async () => {
    copies[ADDRESS] = [["2026-09-01T00:00:00Z", false]]
    const answer = route
    route = (url, method) =>
      url.includes("/web/20260901000000id_/")
        ? { body: archivedPage(true), url: url.replace("20260901000000", "20261020000000") } // a later copy, with the tag
        : answer(url, method)
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default", "the later copy it was sent to is not evidence of the tag before the submission")
    assert.match(verdict.evidence, /no readable archived copy before the submission/)
  })

  it("does not exclude on a copy when a newer one before the submission could not be read (it may show the tag gone)", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-01-29T05:09:03Z", "challenge"]]
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(
      verdict.evidence,
      /archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, but the page's archived copy of 2026-01-29T05:09:03Z, after that, could not be read/
    )
    assert.match(verdict.evidence, /its token logo was written 2025-05-01T00:00:00Z, before the submission \(which dates its profile, not its tag\)/)
  })

  it("takes a copy the archive answers with anything but the page or a 404 for the archive failing", async () => {
    copies[ADDRESS] = [["2026-09-01T00:00:00Z", false]]
    const answer = route
    route = (url, method) => (new URL(url).pathname.startsWith("/web/") ? { status: 403, body: "Forbidden" } : answer(url, method))
    listed()
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default", "the unread copy might have contradicted eth-labels")
    assert.match(verdict.evidence, /its archived copies could not be read \(the Wayback Machine answered HTTP 403 for a copy\)/)
    assert.match(verdict.evidence, /eth-labels lists the public name tag "Treat: TREAT Token" in its copy of 2026-07-10T16:37:25Z, but the Wayback Machine's copies of the page could not be read to confirm it/)
  })

  it("never excludes on a token logo written before the submission: it dates the token's profile, which can come before its tag", async () => {
    const verdict = (await date([token()])).get("a")!
    assert.deepEqual(verdict, {
      decision: "paid by default",
      evidence:
        "tagged today (Treat: TREAT Token), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): never archived; " +
        "its token logo was written 2025-05-01T00:00:00Z, before the submission (which dates its profile, not its tag)",
    })
    assert.deepEqual(earlierAsked, [], "no evidence to clear against the registries")
    assert.ok(!datedUnchecked(verdict), "every source answered: nothing a later run would add")
  })

  it("does not exclude on eth-labels when the page was archived without the tag before the submission, however early (its rows are undated)", async () => {
    listed()
    copies[ADDRESS] = [["2026-03-01T00:00:00Z", false], ["2026-11-20T00:00:00Z", true]] // untagged before eth-labels' copy, tagged again later
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(
      verdict.evidence,
      /eth-labels lists the public name tag "Treat: TREAT Token" in its copy of 2026-07-10T16:37:25Z, but the page was archived without a public name tag on 2026-03-01T00:00:00Z, before the submission/
    )
    copies[ADDRESS] = [["2026-03-01T00:00:00Z", "challenge"], ["2026-11-20T00:00:00Z", true]]
    const unread = (await date([item()])).get("a")!
    assert.equal(unread.decision, "paid by default", "nor when that copy cannot be read")
    assert.match(unread.evidence, /2026-07-10T16:37:25Z, but the page's archived copy of 2026-03-01T00:00:00Z, before the submission, could not be read/)
  })

  it("does not exclude on eth-labels when an earlier Kleros entry of the address came before eth-labels' copy, or when that cannot be checked", async () => {
    listed()
    const registeredAt = (iso: string) => (_item: DatingItem, before: number) =>
      before > unixOf(iso) ? `Kleros entry 0x03@0xee registered this address on ${iso}, and a tag an explorer took from Kleros never counts` : null
    earlier = registeredAt("2026-05-01T00:00:00Z")
    const echo = (await date([item()])).get("a")!
    assert.equal(echo.decision, "paid by default")
    assert.match(echo.evidence, /in its copy of 2026-07-10T16:37:25Z, but Kleros entry 0x03@0xee/)
    assert.deepEqual(earlierAsked, [{ address: ADDRESS, before: unixOf("2026-07-10T16:37:25Z") }], "asked up to eth-labels' copy")
    // the same address in the other registry, after eth-labels' copy: not where the tag it lists came from
    earlier = registeredAt("2026-08-01T00:00:00Z")
    assert.equal((await date([item()])).get("a")!.decision, "excluded")
    earlier = () => "the program's registries could not be checked for an earlier entry of this address (the indexer answered HTTP 503)"
    const unanswered = (await date([item()])).get("a")!
    assert.equal(unanswered.decision, "paid by default", "an unanswered check never excludes")
    assert.ok(datedUnchecked(unanswered))
  })

  it("does not exclude on eth-labels when the earliest copy after the submission could not be read (it might have kept the entry)", async () => {
    listed()
    copies[ADDRESS] = [["2026-10-05T00:00:00Z", "challenge"], ["2026-10-06T00:00:00Z", true]]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(verdict.evidence, /2026-07-10T16:37:25Z, but the page's archived copy of 2026-10-05T00:00:00Z, after the submission, could not be read/)
  })

  it("asks the archive's index again before eth-labels excludes a page it said was never archived (an answer cut short reads the same)", async () => {
    listed()
    copies[ADDRESS] = [["2026-10-05T10:00:00Z", false]] // would keep the entry
    let cut = 1
    const answer = route
    route = (url, method) => (new URL(url).pathname === "/cdx/search/cdx" && cut-- > 0 ? { body: "" } : answer(url, method))
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(
      verdict.evidence,
      /never archived; eth-labels lists the public name tag "Treat: TREAT Token" in its copy of 2026-07-10T16:37:25Z, but the Wayback Machine's index listed copies of the page when asked again/
    )
    assert.ok(datedUnchecked(verdict), "a later run may decide it")

    copies[ADDRESS] = []
    const asked = requests.length
    const confirmed = (await date([item()])).get("a")!
    assert.equal(confirmed.decision, "excluded", "never archived, twice")
    assert.equal(requests.slice(asked).filter((r) => r.url.includes("/cdx/search/cdx")).length, 2)
  })

  it("does not keep on a logo written after the submission while eth-labels or the newest copy before the submission could not be read", async () => {
    logos[LOGO] = "2026-10-10T00:00:00Z"
    ethLabels = null
    const noLabels = (await date([item({ logo: LOGO })])).get("a")!
    assert.equal(noLabels.decision, "paid by default")
    assert.match(noLabels.evidence, /its token logo was written 2026-10-10T00:00:00Z, after the submission, but eth-labels could not be read/)
    assert.ok(datedUnchecked(noLabels), "a later run may decide it")
    ethLabels = { committed: "2026-07-10T16:37:25Z", csv: "address,chainId,label,nameTag\n" }
    copies[ADDRESS] = [["2026-06-01T00:00:00Z", "challenge"]]
    const unread = (await date([item({ logo: LOGO })])).get("a")!
    assert.equal(unread.decision, "paid by default")
    assert.match(unread.evidence, /after the submission, but the page's archived copy of 2026-06-01T00:00:00Z, before the submission, could not be read/)
  })

  it("does not keep on a logo written after the submission while earlier evidence of the tag is left unconfirmed", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-10-20T00:00:00Z", true]]
    logos[LOGO] = "2026-10-10T00:00:00Z"
    earlier = () => "the program's registries could not be checked for an earlier entry of this address (the indexer answered HTTP 503)"
    const verdict = (await date([item({ logo: LOGO })])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(verdict.evidence, /archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, but the program's registries could not be checked/)
    assert.match(verdict.evidence, /its token logo was written 2026-10-10T00:00:00Z, after the submission, but the evidence of a tag before the submission above could not be confirmed/)
    assert.ok(datedUnchecked(verdict))
  })

  it("keeps a token whose logo the explorer wrote after the submission (an import after it)", async () => {
    const logo = "https://arc.etherscan.io/token/images/arcstockpad_aspad_64.png"
    logos[logo] = "2026-10-13T04:22:00Z"
    const verdict = (await date([item({ host: "arc.etherscan.io", chainId: "5042", submissionTime: unixOf("2026-10-12T17:53:00Z"), logo })])).get("a")!
    assert.deepEqual(verdict, { decision: "kept", evidence: `its token logo ${logo} was written 2026-10-13T04:22:00Z, after the submission (2026-10-12T17:53:00Z)` })
  })

  it("excludes on eth-labels listing the tag in a copy committed before the submission, unless the archive or an earlier Kleros entry says otherwise", async () => {
    ethLabels = {
      committed: "2026-07-10T16:37:25Z",
      csv: 'address,chainId,label,nameTag\n"0x929ec64c34a17401f460460d4b9390518e5b473e",10,"aave","Aave: Incentives V3"\n"0x1111111111111111111111111111111111111111",10,"x",""\n',
    }
    const aave = "0x929EC64c34a17401F460460D4B9390518E5B473e"
    const op = (key: string, submitted: string) =>
      item({ key, host: "optimistic.etherscan.io", chainId: "10", address: aave, tagged: null, names: [], submissionTime: unixOf(submitted) })
    const verdicts = await date([
      op("after", "2026-10-28T09:05:00Z"),
      op("before", "2026-07-01T00:00:00Z"),
      item({ key: "other chain", host: "arbiscan.io", chainId: "42161", address: aave, tagged: null, names: [], submissionTime: unixOf("2026-10-28T09:05:00Z") }),
    ])
    assert.deepEqual(verdicts.get("after"), {
      decision: "excluded",
      evidence:
        'eth-labels lists the public name tag "Aave: Incentives V3" in its copy of 2026-07-10T16:37:25Z, before the submission (2026-10-28T09:05:00Z): ' +
        `https://github.com/dawsbot/eth-labels/blob/${"a".repeat(40)}/data/csv/accounts.csv`,
    })
    assert.equal(verdicts.get("before")!.decision, "paid by default", "a copy committed after the submission proves nothing about it")
    assert.equal(verdicts.get("other chain")!.decision, "paid by default", "a tag on another chain's explorer is not this one")
    assert.match(verdicts.get("other chain")!.evidence, /^its explorer could not be read, with no dated evidence of a tag at the submission/)
    assert.equal(asked("api.github.com") + asked("raw.githubusercontent.com"), 2, "downloaded once for the run")

    earlier = () => "Kleros entry 0x02@0x66 registered this address on 2023-05-01T00:00:00.000Z, and a tag an explorer took from Kleros never counts"
    const echo = (await date([op("a", "2026-10-28T09:05:00Z")])).get("a")!
    assert.equal(echo.decision, "paid by default")
    assert.match(echo.evidence, /eth-labels lists the public name tag "Aave: Incentives V3" in its copy of 2026-07-10T16:37:25Z, but Kleros entry 0x02@0x66/)

    earlier = () => null
    copies[aave.toLowerCase()] = [["2026-09-01T00:00:00Z", false]]
    const untagged = (await date([op("a", "2026-10-28T09:05:00Z")])).get("a")!
    assert.equal(untagged.decision, "paid by default", "archived untagged after eth-labels' copy: the tag went before the submission")
  })

  it("finds the copies on both sides of the submission of a page archived more often than one answer holds", async () => {
    copies[ADDRESS] = [["2026-03-01T00:00:00Z", true]].concat(
      Array.from({ length: 50 }, (_, i) => [new Date((SUBMITTED + (i + 1) * DAY) * 1000).toISOString(), true])
    ) as [string, boolean][]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "excluded")
    assert.match(verdict.evidence, /archived with the public name tag "Treat: TREAT Token" on 2026-03-01T00:00:00Z, before the submission/)
    const queries = requests.filter((r) => r.url.includes("/cdx/search/cdx")).map((r) => new URL(r.url).searchParams)
    assert.deepEqual(
      queries.map((q) => [q.get("from"), q.get("to"), q.get("limit")]),
      [
        [null, null, "-50"],
        [waybackTimestamp(SUBMITTED + 1), null, "3"],
        [null, waybackTimestamp(SUBMITTED - 1), "-3"],
      ]
    )
  })

  it("takes an index that lists no copy after the submission when asked for the earliest, after listing 50, for failing", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true]].concat(
      Array.from({ length: 50 }, (_, i) => [new Date((SUBMITTED + (i + 1) * DAY) * 1000).toISOString(), true])
    ) as [string, boolean][]
    const answer = route
    route = (url, method) => (new URL(url).searchParams.get("from") ? { body: "[]" } : answer(url, method))
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default", "the copies right after the submission, which could keep it, are unknown")
    assert.match(verdict.evidence, /the Wayback Machine's index gave no copy after the submission when asked for the earliest/)
  })

  it("asks again before eth-labels excludes a page whose copies before the submission the index answered with none, past 50 later ones", async () => {
    listed()
    copies[ADDRESS] = ([["2026-09-01T00:00:00Z", false]] as [string, boolean][]).concat(
      Array.from({ length: 50 }, (_, i) => [new Date((SUBMITTED + (i + 1) * DAY) * 1000).toISOString(), true]) as [string, boolean][]
    )
    let cut = 1
    const answer = route
    route = (url, method) => (new URL(url).searchParams.get("to") && cut-- > 0 ? { body: "" } : answer(url, method))
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "paid by default", "the untagged copy of 2026-09-01 is there when asked again")
    assert.match(verdict.evidence, /but the Wayback Machine's index listed copies of the page when asked again/)
    copies[ADDRESS] = copies[ADDRESS].slice(1)
    assert.equal((await date([item()])).get("a")!.decision, "excluded", "none before the submission, twice")
  })

  it("keeps a page archived without its tag right after the submission, though more copies came later than one answer holds", async () => {
    // tagged before, untagged the first hours after the submission, then tagged in 50 later copies
    const hours = Array.from({ length: 10 }, (_, i) => [new Date((SUBMITTED + (i + 1) * 3600) * 1000).toISOString(), false])
    const later = Array.from({ length: 50 }, (_, i) => [new Date((SUBMITTED + 2 * DAY + i * 3600) * 1000).toISOString(), true])
    copies[ADDRESS] = ([["2025-01-16T09:17:35Z", true]] as [string, boolean][]).concat(hours as [string, boolean][], later as [string, boolean][])
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "kept", "the copies the first answer left out keep it")
    assert.match(verdict.evidence, /^archived without a public name tag on 2026-10-04T15:33:00Z, after the submission/)
  })

  it("never keeps on a logo written after the submission when the archive could not be asked, and says so", async () => {
    archiveDown = true
    const verdicts = await date([token({ key: "before" }), token({ key: "after", submissionTime: unixOf("2025-04-25T00:00:00Z") })])
    assert.equal(verdicts.get("before")!.decision, "paid by default")
    assert.match(verdicts.get("before")!.evidence, /its token logo was written 2025-05-01T00:00:00Z, before the submission \(which dates its profile, not its tag\)/)
    assert.equal(verdicts.get("after")!.decision, "paid by default", "nor keep on it: a copy before the submission might show the tag")
    assert.match(verdicts.get("after")!.evidence, /its token logo was written 2025-05-01T00:00:00Z, after the submission, but the Wayback Machine could not be asked about earlier copies/)
    for (const key of ["before", "after"]) {
      assert.ok(datedUnchecked(verdicts.get(key)!), "a later run may decide it")
      assert.match(verdicts.get(key)!.evidence, /; archived copies: https:\/\/web\.archive\.org\/web\/\*\/https:\/\/[a-z.]+\/address\/0x[0-9a-fA-F]{40}$/, "the archive's list of copies")
    }
  })

  it("pays by default when the archive does not answer, retrying, and stops asking it after two entries in a row", async () => {
    archiveDown = true
    const verdicts = await date(["1", "2", "3", "4"].map((key) => item({ key })))
    for (const key of ["1", "2", "3", "4"]) {
      assert.equal(verdicts.get(key)!.decision, "paid by default")
      assert.match(verdicts.get(key)!.evidence, /the Wayback Machine did not answer \(HTTP 503\)/)
    }
    assert.match(verdicts.get("3")!.evidence, /not asked again in this run/)
    assert.equal(asked("web.archive.org"), 6, "3 attempts for each of the first 2 entries, none for the others")
    assert.deepEqual(slept.filter((s) => s >= 30), [30, 90, 30, 90], "backing off 30 s, then 90 s")
  })

  it("waits as long as the archive asks when it rate-limits, then goes on", async () => {
    copies[ADDRESS] = [["2026-10-05T10:00:00Z", false]]
    let limited = 1
    const answer = route
    route = (url, method) =>
      new URL(url).host === "web.archive.org" && limited-- > 0 ? { status: 429, headers: { "retry-after": "7" }, body: "slow down" } : answer(url, method)
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "kept")
    assert.ok(slept.includes(7) && !slept.includes(30), "its Retry-After, not the default back-off")
  })

  it("stops downloading archived pages at once when the archive refuses them (its bot block), still asking its index", async () => {
    const other = "0x29cc30f9d113b356ce408667aa6433589cecbdca"
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true]]
    const answer = route
    route = (url, method) =>
      new URL(url).pathname.startsWith("/web/")
        ? { status: 429, body: "Your request is being blocked because our system has flagged it as suspected abusive bot traffic" }
        : answer(url, method)
    logos["https://basescan.org/token/images/Elsa_64.png"] = "2026-01-28T07:40:53Z"
    const verdicts = await date([
      item({ key: "1" }),
      item({ key: "2" }),
      item({ key: "never archived", host: "basescan.org", chainId: "8453", address: other, logo: "https://basescan.org/token/images/Elsa_64.png" }),
    ])
    for (const key of ["1", "2"]) {
      assert.equal(verdicts.get(key)!.decision, "paid by default")
      assert.match(verdicts.get(key)!.evidence, /the Wayback Machine refuses this machine's requests \(HTTP 429, flagged as bot traffic\)/)
    }
    assert.match(verdicts.get("2")!.evidence, /its pages not asked again in this run/)
    for (const key of ["1", "2"]) {
      assert.ok(
        verdicts.get(key)!.evidence.endsWith(`; archived copies: https://web.archive.org/web/20250116091735/https://etherscan.io/address/${ADDRESS}`),
        "the copy the index named"
      )
      assert.ok(datedUnchecked(verdicts.get(key)!))
    }
    assert.equal(verdicts.get("never archived")!.decision, "paid by default", "a logo written before the submission excludes nothing")
    assert.match(verdicts.get("never archived")!.evidence, /never archived; its token logo was written 2026-01-28T07:40:53Z, before the submission/)
    assert.deepEqual(
      requests.filter((r) => new URL(r.url).host === "web.archive.org").map((r) => new URL(r.url).pathname.split("/")[1]),
      ["cdx", "web", "cdx", "cdx"],
      "one page refused, no retry: the index alone afterwards"
    )
    assert.ok(!slept.includes(30), "no back-off: a bot block lasts hours")
  })

  it("stops asking the archive once its time for the run is spent", async () => {
    copies[ADDRESS] = [["2026-10-05T10:00:00Z", false]]
    const verdicts = await date([item({ key: "1" }), item({ key: "2" })], { archiveBudgetMs: 0 })
    for (const key of ["1", "2"]) {
      assert.equal(verdicts.get(key)!.decision, "paid by default")
      assert.match(verdicts.get(key)!.evidence, /time budget for the run is spent/)
    }
    assert.equal(asked("web.archive.org"), 0)
  })

  it("stops asking an explorer for logos after three failures in a row", async () => {
    const answer = route
    route = (url, method) => (/\/token\/images\//.test(new URL(url).pathname) ? { status: 503 } : answer(url, method))
    const verdicts = await date(["1", "2", "3", "4"].map((key) => token({ key })))
    assert.match(verdicts.get("1")!.evidence, /its token logo could not be read \(HTTP 503\)/)
    assert.match(verdicts.get("4")!.evidence, /etherscan\.io's token logos did not answer \(HTTP 503\); not asked again in this run/)
    assert.equal(requests.filter((r) => r.method === "HEAD").length, 6, "2 attempts for each of the first 3 entries")
  })

  it("pays by default without a submission time, and Solscan, Blockscout tags and unreadable Blockscout without asking the archive", async () => {
    const verdicts = await date([
      item({ key: "no time", submissionTime: undefined }),
      item({ key: "solana", host: "solscan.io", chainId: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", tagged: null, names: [] }),
      item({ key: "oli", host: "robinhoodchain.blockscout.com", chainId: "46630", names: ["Escrow"] }),
      item({ key: "blockscout down", host: "gnosis.blockscout.com", chainId: "100", tagged: null, names: [] }),
    ])
    assert.match(verdicts.get("no time")!.evidence, /the indexer gave no submission time/)
    assert.match(verdicts.get("solana")!.evidence, /solscan\.io keeps no dated copy a script can read/)
    assert.match(verdicts.get("oli")!.evidence, /^tagged today \(Escrow\), with no dated evidence of a tag at the submission/)
    assert.match(verdicts.get("blockscout down")!.evidence, /gnosis\.blockscout\.com keeps no dated copy a script can read/)
    for (const key of ["no time", "solana", "oli", "blockscout down"]) assert.equal(verdicts.get(key)!.decision, "paid by default", key)
    assert.equal(requests.length, 0)
  })

  it("gives entries read untagged today no verdict, and asks nothing for them", async () => {
    const verdicts = await date([item({ tagged: false })])
    assert.equal(verdicts.size, 0)
    assert.equal(requests.length, 0)
  })
})

describe("tag dating: eth-labels' file", () => {
  it("reads quoted fields and keeps only rows naming a tag, by chain and lowercase address", () => {
    const tags = parseEthLabelsCsv(
      'address,chainId,label,nameTag\r\n"0xAbC0000000000000000000000000000000000001",1,"x","Foo, ""Bar"" Pool"\r\n"0x2",1,"y",""\r\n\r\n'
    )
    assert.deepEqual(Array.from(tags.entries()), [["1:0xabc0000000000000000000000000000000000001", 'Foo, "Bar" Pool']])
  })

  it("refuses a file whose columns changed", () => {
    assert.throws(() => parseEthLabelsCsv("addr,chain,tag\n"), /unexpected columns/)
  })
})

describe("tag dating: the verdicts paid by default because a source did not answer", () => {
  const paid = (evidence: string) => ({ decision: "paid by default", evidence })
  const refused = "the Wayback Machine refuses this machine's requests (HTTP 429, flagged as bot traffic)"

  it("marks a verdict the archive, eth-labels or the registries left unchecked: one a later run may decide otherwise", () => {
    const cases: [string, { decision: string; evidence: string }, boolean][] = [
      [
        "an eth-labels listing the archive could not confirm",
        paid(`its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-28T09:05:45Z): its archived copies could not be read (${refused}); eth-labels lists the public name tag "Aave: Incentives V3" in its copy of 2026-07-10T16:37:25Z, but the Wayback Machine's copies of the page could not be read to confirm it (${refused})`),
        true,
      ],
      [
        "an archived tag the registries could not clear",
        paid(`tagged today (X), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): archived with the public name tag "X" on 2025-01-16T09:17:35Z, but the program's registries could not be checked for an earlier entry of this address (the indexer answered HTTP 503)`),
        true,
      ],
      ["the archive refused, nothing else known", paid(`its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-27T00:32:15Z): its archived copies could not be read (${refused})`), true],
      ["eth-labels could not be read", paid("tagged today (X), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): never archived; eth-labels could not be read (GitHub answered HTTP 403)"), true],
      ["an earlier Kleros entry: decided", paid(`eth-labels lists the public name tag "A" in its copy of 2026-07-10T16:37:25Z, but Kleros entry 0x02@0x66 registered this address on 2023-05-01T00:00:00.000Z`), false],
      ["never archived", paid("its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-18T07:43:25Z): never archived"), false],
      [
        "a logo written before the submission",
        paid("tagged today (X), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): never archived; its token logo was written 2025-05-01T00:00:00Z, before the submission (which dates its profile, not its tag)"),
        false,
      ],
      ["Solscan", paid("its explorer could not be read, and solscan.io keeps no dated copy a script can read"), false],
      ["excluded", { decision: "excluded", evidence: `archived with the public name tag "X" on 2025-01-16T09:17:35Z, before the submission (2026-10-04T14:33:00Z): https://web.archive.org/web/20250116091735/x` }, false],
    ]
    for (const [what, verdict, unchecked] of cases) assert.equal(datedUnchecked(verdict), unchecked, what)
  })
})
