import { afterEach, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { gzipSync } from "zlib"
import { dateExplorerTags, datedEarlyEvidence, datedUnchecked, DatingItem, DatingOptions, parseEthLabelsCsv, waybackTimestamp } from "../../src/utils/tag-dating"

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
  // a token whose page shows its logo, written in 2025 by the explorer, and its 2025 contract
  const token = (overrides: Partial<DatingItem> = {}): DatingItem => {
    logos[LOGO] = "2025-05-01T00:00:00Z"
    return item({ logo: LOGO, createdAt: unixOf("2025-04-20T00:00:00Z"), ...overrides })
  }
  const asked = (host: string) => requests.filter((r) => new URL(r.url).host === host).length

  it("keeps an entry archived without its tag after the submission, asking nothing more", async () => {
    copies[ADDRESS] = [["2026-01-29T05:09:03Z", true], ["2026-10-05T10:00:00Z", false]]
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "kept")
    assert.match(verdict.evidence, /^archived without a public name tag on 2026-10-05T10:00:00Z, after the submission \(2026-10-04T14:33:00Z\): https:\/\/web\.archive\.org\/web\/20261005100000\//)
    assert.equal(asked("etherscan.io") + asked("api.github.com"), 0, "the copy after the submission settles it: neither its logo nor eth-labels")
  })

  it("excludes an entry archived with its tag before the submission, reading compressed copies and skipping a challenge", async () => {
    copies[ADDRESS] = [["2025-01-16T09:17:35Z", true], ["2026-10-10T00:00:00Z", "challenge"], ["2026-10-20T00:00:00Z", true]]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "excluded")
    assert.equal(
      verdict.evidence,
      `archived with the public name tag "Treat: TREAT Token" on 2025-01-16T09:17:35Z, before the submission (2026-10-04T14:33:00Z): ` +
        `https://web.archive.org/web/20250116091735/https://etherscan.io/address/${ADDRESS}`
    )
    assert.deepEqual(earlierAsked, [{ address: ADDRESS, before: unixOf("2025-01-16T09:17:35Z") }], "no earlier Kleros entry of the address was asked about first")
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
    assert.match(verdict.evidence, /its token logo was written 2025-05-01T00:00:00Z, before the submission, but the page's archived copy of 2026-01-29T05:09:03Z/)
  })

  it("takes a copy the archive answers with anything but the page or a 404 for the archive failing", async () => {
    copies[ADDRESS] = [["2026-09-01T00:00:00Z", false]]
    const answer = route
    route = (url, method) => (new URL(url).pathname.startsWith("/web/") ? { status: 403, body: "Forbidden" } : answer(url, method))
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "paid by default", "the unread copy might have contradicted the logo")
    assert.match(verdict.evidence, /could not be read to confirm it \(the Wayback Machine answered HTTP 403 for a copy\)/)
  })

  it("excludes on a token logo written before the submission, unless the file is older than the contract (shared) or the contract's age is unknown", async () => {
    const logo = (name: string) => `https://etherscan.io/token/images/${name}_32.png`
    logos[logo("treat")] = "2023-08-27T10:00:00Z"
    logos[logo("bridged")] = "2021-03-01T00:00:00Z"
    const created = unixOf("2023-01-14T00:00:00Z")
    const verdicts = await date([
      item({ key: "own", logo: logo("treat"), createdAt: created }),
      item({ key: "shared", logo: logo("bridged"), createdAt: created }),
      item({ key: "age unknown", logo: logo("treat") }),
    ])
    assert.deepEqual(verdicts.get("own"), {
      decision: "excluded",
      evidence: `its token logo ${logo("treat")} was written 2023-08-27T10:00:00Z, before the submission (2026-10-04T14:33:00Z)`,
    })
    assert.equal(verdicts.get("shared")!.decision, "paid by default")
    assert.match(verdicts.get("shared")!.evidence, /never archived; its token logo was written 2021-03-01T00:00:00Z, before the contract \(2023-01-14T00:00:00Z\): a shared file/)
    assert.equal(verdicts.get("age unknown")!.decision, "paid by default")
    assert.match(verdicts.get("age unknown")!.evidence, /the contract's age could not be read/)
  })

  it("does not exclude on a logo the archive shows the tag did not come with (an untagged copy after it, before the submission)", async () => {
    copies[ADDRESS] = [["2026-09-30T00:00:00Z", false], ["2026-10-20T00:00:00Z", true]]
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(
      verdict.evidence,
      /its token logo was written 2025-05-01T00:00:00Z, before the submission, but the page was archived without a public name tag on 2026-09-30T00:00:00Z, after that/
    )
    copies[ADDRESS] = [["2025-03-01T00:00:00Z", false]] // untagged before the logo was written: no contradiction
    assert.equal((await date([token()])).get("a")!.decision, "excluded")
  })

  it("does not exclude on a logo when an earlier Kleros entry of the address may have made the profile, or when that cannot be checked", async () => {
    earlier = (_item, before) =>
      before >= unixOf("2025-01-01T00:00:00Z") ? "Kleros entry 0x03@0xee registered this address on 2024-11-01T00:00:00.000Z, and a tag an explorer took from Kleros never counts" : null
    const echo = (await date([token()])).get("a")!
    assert.equal(echo.decision, "paid by default")
    assert.match(echo.evidence, /its token logo was written 2025-05-01T00:00:00Z, before the submission, but Kleros entry 0x03@0xee/)
    assert.deepEqual(earlierAsked, [{ address: ADDRESS, before: unixOf("2025-05-01T00:00:00Z") }], "asked about the logo's date")
    earlier = () => "the program's registries could not be checked for an earlier entry of this address (the indexer answered HTTP 503)"
    assert.equal((await date([token()])).get("a")!.decision, "paid by default", "an unanswered check never excludes")
  })

  it("does not exclude on a logo when an earlier copy after the submission was skipped (it might have kept the entry)", async () => {
    copies[ADDRESS] = [["2026-10-05T00:00:00Z", "challenge"], ["2026-10-06T00:00:00Z", true]]
    const verdict = (await date([token()])).get("a")!
    assert.equal(verdict.decision, "paid by default")
    assert.match(verdict.evidence, /before the submission, but the page's archived copy of 2026-10-05T00:00:00Z, after the submission, could not be read/)
  })

  it("keeps a token whose logo the explorer wrote after the submission (an import after it)", async () => {
    const logo = "https://arc.etherscan.io/token/images/arcstockpad_aspad_64.png"
    logos[logo] = "2026-10-13T04:22:00Z"
    const verdict = (await date([item({ host: "arc.etherscan.io", chainId: "5042", submissionTime: unixOf("2026-10-12T17:53:00Z"), logo, createdAt: unixOf("2026-08-01T00:00:00Z") })])).get("a")!
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

  it("finds the copies before the submission of a page archived more often than one answer holds", async () => {
    copies[ADDRESS] = [["2026-03-01T00:00:00Z", true]].concat(
      Array.from({ length: 50 }, (_, i) => [new Date((SUBMITTED + (i + 1) * DAY) * 1000).toISOString(), true])
    ) as [string, boolean][]
    const verdict = (await date([item()])).get("a")!
    assert.equal(verdict.decision, "excluded")
    assert.match(verdict.evidence, /archived with the public name tag "Treat: TREAT Token" on 2026-03-01T00:00:00Z, before the submission/)
    const queries = requests.filter((r) => r.url.includes("/cdx/search/cdx")).map((r) => new URL(r.url).searchParams)
    assert.deepEqual(queries.map((q) => [q.get("to"), q.get("limit")]), [[null, "-50"], [waybackTimestamp(SUBMITTED - 1), "-3"]])
  })

  it("never excludes on a logo the archive could not be asked to confirm, and says so", async () => {
    archiveDown = true
    const verdicts = await date([token({ key: "before" }), token({ key: "after", submissionTime: unixOf("2025-04-25T00:00:00Z") })])
    assert.equal(verdicts.get("before")!.decision, "paid by default")
    assert.match(verdicts.get("before")!.evidence, /its token logo was written 2025-05-01T00:00:00Z, before the submission, but the Wayback Machine could not be asked to confirm it/)
    assert.equal(verdicts.get("after")!.decision, "paid by default", "nor keep on it: a copy before the submission might show the tag")
    assert.match(verdicts.get("after")!.evidence, /its token logo was written 2025-05-01T00:00:00Z, after the submission, but the Wayback Machine could not be asked about earlier copies/)
    // both left for a person to check, the one with early evidence first
    assert.ok(datedUnchecked(verdicts.get("before")!) && datedEarlyEvidence(verdicts.get("before")!))
    assert.ok(datedUnchecked(verdicts.get("after")!) && !datedEarlyEvidence(verdicts.get("after")!))
    for (const key of ["before", "after"]) {
      assert.match(verdicts.get(key)!.evidence, /; to look at by hand: https:\/\/web\.archive\.org\/web\/\*\/https:\/\/[a-z.]+\/address\/0x[0-9a-fA-F]{40}$/, "the archive's list of copies")
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
      item({ key: "never archived", host: "basescan.org", chainId: "8453", address: other, logo: "https://basescan.org/token/images/Elsa_64.png", createdAt: unixOf("2026-01-08T00:00:00Z") }),
    ])
    for (const key of ["1", "2"]) {
      assert.equal(verdicts.get(key)!.decision, "paid by default")
      assert.match(verdicts.get(key)!.evidence, /the Wayback Machine refuses this machine's requests \(HTTP 429, flagged as bot traffic\)/)
    }
    assert.match(verdicts.get("2")!.evidence, /its pages not asked again in this run/)
    for (const key of ["1", "2"]) {
      assert.ok(
        verdicts.get(key)!.evidence.endsWith(`; to look at by hand: https://web.archive.org/web/20250116091735/https://etherscan.io/address/${ADDRESS}`),
        "the copy the index named, for a person to open"
      )
      assert.ok(datedUnchecked(verdicts.get(key)!) && datedEarlyEvidence(verdicts.get(key)!) === false, "unchecked, with no early evidence read")
    }
    assert.equal(verdicts.get("never archived")!.decision, "excluded", "a page the index shows was never archived needs no page to confirm its logo")
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

describe("tag dating: the verdicts left for a person to check", () => {
  const paid = (evidence: string) => ({ decision: "paid by default", evidence })
  const refused = "the Wayback Machine refuses this machine's requests (HTTP 429, flagged as bot traffic)"

  it("marks a verdict the archive or the registries left unchecked, and among them one with early evidence", () => {
    const cases: [string, { decision: string; evidence: string }, boolean, boolean][] = [
      [
        "an early logo the archive could not confirm",
        paid(`tagged today (Treat: TREAT Token), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): its archived copies could not be read (${refused}); its token logo was written 2023-08-27T23:36:59Z, before the submission, but the Wayback Machine's copies of the page could not be read to confirm it (${refused})`),
        true,
        true,
      ],
      [
        "an eth-labels listing the archive could not confirm",
        paid(`its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-28T09:05:45Z): its archived copies could not be read (${refused}); eth-labels lists the public name tag "Aave: Incentives V3" in its copy of 2026-07-10T16:37:25Z, but the Wayback Machine's copies of the page could not be read to confirm it (${refused})`),
        true,
        true,
      ],
      [
        "an archived tag the registries could not clear",
        paid(`tagged today (X), with no dated evidence of a tag at the submission (2026-10-04T14:33:00Z): archived with the public name tag "X" on 2025-01-16T09:17:35Z, but the program's registries could not be checked for an earlier entry of this address (the indexer answered HTTP 503)`),
        true,
        true,
      ],
      ["the archive refused, nothing else known", paid(`its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-27T00:32:15Z): its archived copies could not be read (${refused})`), true, false],
      ["an earlier Kleros entry: decided, nothing to check", paid(`eth-labels lists the public name tag "A" in its copy of 2026-07-10T16:37:25Z, but Kleros entry 0x02@0x66 registered this address on 2023-05-01T00:00:00.000Z`), false, false],
      ["never archived: nothing a person could add", paid("its explorer could not be read, with no dated evidence of a tag at the submission (2026-10-18T07:43:25Z): never archived"), false, false],
      ["Solscan", paid("its explorer could not be read, and solscan.io keeps no dated copy a script can read"), false, false],
      ["excluded", { decision: "excluded", evidence: `archived with the public name tag "X" on 2025-01-16T09:17:35Z, before the submission (2026-10-04T14:33:00Z): https://web.archive.org/web/20250116091735/x` }, false, false],
    ]
    for (const [what, verdict, unchecked, early] of cases) {
      assert.equal(datedUnchecked(verdict), unchecked, `${what}: unchecked`)
      assert.equal(datedEarlyEvidence(verdict), early, `${what}: early evidence`)
    }
  })
})
