import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { fetchTags, registrationLookup } from "../../src/tag-fetch"
import { fetchAtqAbsent, fetchAtqRegistered, fetchRemovals } from "../../src/removals-fetch"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { evmAddress, REGISTRY, SOLANA_CHAIN, unix } from "../support/fixtures"
import { MockItem, MockSubgraph, subgraphItem } from "../support/subgraph"
import { MockServer, startMockServer } from "../support/http"
import { ipfsPath, keysFromItemFile } from "../../src/utils/item-data"
import { unlinkSync, writeFileSync } from "fs"

const PERIOD = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") }
const IN = unix("2026-09-15T00:00:00Z")
const BEFORE = unix("2026-08-20T00:00:00Z")
const AFTER = unix("2026-10-02T00:00:00Z")

const registration = (requester: string, resolutionTime: number) => ({
  requester,
  requestType: "RegistrationRequested" as const,
  resolutionTime,
  submissionTime: resolutionTime - 3600,
})
const clearing = (requester: string, resolutionTime: number) => ({
  requester,
  requestType: "ClearingRequested" as const,
  resolutionTime,
  submissionTime: resolutionTime - 3600,
})

let subgraph: MockSubgraph
let logs: CapturedConsole
let restoreEnv: () => void
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(async () => {
  subgraph = await new MockSubgraph().start()
  restoreEnv = setEnv({ XDAI_GTCR_SUBGRAPH_URL: subgraph.url })
  logs.clear()
})
afterEach(async () => {
  restoreEnv()
  await subgraph.stop()
})

describe("registrationLookup (the explorer check's earlier Kleros entries)", () => {
  it("finds every Address Tags and Tokens registration of an address, whatever its spelling, reading both registries once", async () => {
    const checksummed = "0x929EC64c34a17401F460460D4B9390518E5B473e"
    const lower = checksummed.toLowerCase()
    const SINCE_REMOVED = BEFORE - 86400 * 400
    subgraph.add(
      subgraphItem("addressTags", { requests: [registration(evmAddress(1), BEFORE)], key0: `eip155:10:${lower}` }),
      subgraphItem("tokens", { requests: [registration(evmAddress(2), IN), clearing(evmAddress(9), AFTER)], key0: `eip155:10:${checksummed}` }),
      // written in no usual spelling, removed since: still an earlier entry
      subgraphItem("tokens", { requests: [registration(evmAddress(3), SINCE_REMOVED)], key0: "eip155:10:0x929ec64C34A17401f460460d4b9390518e5b473E ", status: "Absent" }),
      subgraphItem("domains", { requests: [registration(evmAddress(4), BEFORE - 86400)], key0: `eip155:10:${checksummed}` }), // a CDN entry: not a tag
      subgraphItem("addressTags", { requests: [registration(evmAddress(5), 0)], key0: `eip155:10:${checksummed}` }), // pending: not registered
      subgraphItem("addressTags", { requests: [registration(evmAddress(6), BEFORE)], key0: `eip155:42161:${lower}` }) // another chain
    )
    const lookup = registrationLookup()
    const found = await lookup("10", checksummed)
    assert.deepEqual(found.map((r) => r.resolvedAt), [SINCE_REMOVED, BEFORE, IN], "the earliest first, removal requests, pending ones and CDN left out")
    assert.deepEqual(await lookup("10", lower), found)
    assert.deepEqual((await lookup("42161", checksummed)).map((r) => r.resolvedAt), [BEFORE])
    assert.deepEqual(await lookup("10", evmAddress(0xfee)), [])
    const reads = subgraph.queries.filter((q) => q.idGt !== undefined)
    assert.deepEqual(reads.map((q) => q.registry), [REGISTRY.addressTags, REGISTRY.tokens], "each registry read once, for every question")
  })

  it("says so when the indexer cannot answer", async () => {
    subgraph.fault = { status: 503 }
    await assert.rejects(registrationLookup()("10", evmAddress(1)), /the indexer answered HTTP 503/)
  })

  describe("with entries the indexer left blank", () => {
    let ipfs: MockServer
    let files: { [path: string]: { status?: number; body?: unknown } }
    let restoreGateways: () => void
    beforeEach(async () => {
      files = {}
      ipfs = await startMockServer((req) => files[req.path] || { status: 404, body: { error: "not found" } })
      restoreGateways = setEnv({ IPFS_READ_GATEWAYS: `${ipfs.url}/ipfs` })
    })
    afterEach(async () => {
      restoreGateways()
      await ipfs.close()
    })
    const itemFile = (key0: string) => ({
      columns: [
        { label: "Address", type: "rich address", isIdentifier: true },
        { label: "Name", type: "text", isIdentifier: true },
      ],
      values: { Address: key0, Name: "Some contract" },
    })

    it("reads their address from their IPFS file or their inline data, and leaves out files that name none", async () => {
      const fromFile = evmAddress(0xf11e)
      const inline = evmAddress(0x111e)
      files["/ipfs/QmEarlier/item.json"] = { body: itemFile(`eip155:1:${fromFile}`) }
      files["/ipfs/QmNoAddress/item.json"] = { body: { columns: [{ label: "Name", type: "text" }], values: { Name: "x" } } }
      subgraph.add(
        subgraphItem("addressTags", { requests: [registration(evmAddress(1), BEFORE)], key0: "", data: "/ipfs/QmEarlier/item.json" }),
        subgraphItem("addressTags", { requests: [registration(evmAddress(2), BEFORE)], key0: "", data: JSON.stringify(itemFile(`eip155:1:${inline}`)) }),
        subgraphItem("tokens", { requests: [registration(evmAddress(3), BEFORE)], key0: "", data: "/ipfs/QmNoAddress/item.json" }),
        subgraphItem("tokens", { requests: [registration(evmAddress(4), BEFORE)], key0: "", data: JSON.stringify({ columns: [], values: {} }) }),
        // malformed for good: named in a warning, left out (failing on it would keep every run from excluding anything)
        subgraphItem("addressTags", { requests: [registration(evmAddress(7), BEFORE)], key0: "", data: "{ not json" })
      )
      const lookup = registrationLookup()
      assert.deepEqual((await lookup("1", fromFile)).map((r) => r.resolvedAt), [BEFORE])
      assert.deepEqual((await lookup("1", inline)).map((r) => r.resolvedAt), [BEFORE])
      assert.ok(logs.has("an earlier entry's data is malformed, its address unknown (left out)"))
    })

    it("fails, keeping every entry from being excluded, when a blank entry's address cannot be read: it might be any", async () => {
      subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(5), BEFORE)], key0: "", data: "/ipfs/QmGone/item.json" }))
      await assert.rejects(registrationLookup()("1", evmAddress(6)), /the address of 1 earlier entry could not be read \(0x[0-9a-f]{64}@0x[0-9a-f]{40}: its IPFS file \/ipfs\/QmGone\/item\.json could not be read/)
    })
  })
})

describe("fetchTags", () => {
  it("returns the live items of the three registries registered in the period", async () => {
    const tag = subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key0: "eip155:8453:0xAbC0000000000000000000000000000000000001", key1: "Uniswap Router" })
    // challenged since: its removal request is pending, which resets the
    // indexer's latestRequestResolutionTime to 0
    const token = subgraphItem("tokens", {
      requests: [registration(evmAddress(2), IN), clearing(evmAddress(8), 0)],
      status: "ClearingRequested",
      key0: `solana:${SOLANA_CHAIN}:So11111111111111111111111111111111111111112`,
    })
    const domain = subgraphItem("domains", { requests: [registration(evmAddress(3), IN)] })
    subgraph.add(
      tag,
      token,
      domain,
      subgraphItem("tokens", { requests: [registration(evmAddress(4), BEFORE)] }),
      subgraphItem("tokens", { requests: [registration(evmAddress(5), AFTER)] }),
      subgraphItem("domains", { requests: [registration(evmAddress(6), IN)], status: "Absent" }),
      subgraphItem("domains", { requests: [registration(evmAddress(7), IN)], status: "RegistrationRequested" })
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(
      tags.map((t) => [t.registry, t.submitter]),
      [["addressTags", evmAddress(1)], ["tokens", evmAddress(2)], ["domains", evmAddress(3)]]
    )
    assert.deepEqual(tags[0], {
      id: tag.id,
      registry: "addressTags",
      chain: "8453",
      submitter: evmAddress(1),
      tagAddress: "0xAbC0000000000000000000000000000000000001",
      latestRequestResolutionTime: IN,
      submissionTime: IN - 3600, // the registration's: what the explorer rule dates against
      isTokenOnAddressTags: false,
      addressTagName: "uniswap router",
    })
    assert.equal(tags[1].chain, SOLANA_CHAIN)
    assert.equal(tags[1].addressTagName, "")
    const windows = subgraph.queries.filter((q) => q.gte !== undefined)
    assert.ok(windows.every((q) => q.gte === unix("2026-09-01T00:00:00Z") && q.lt === unix("2026-10-01T00:00:00Z")))
  })

  it("pages through registries of more than 1,000 items", async () => {
    const items = Array.from({ length: 2345 }, (_, i) => subgraphItem("tokens", { requests: [registration(evmAddress(i + 10), IN)] }))
    subgraph.add(...items)
    const tags = await fetchTags(PERIOD)
    assert.equal(tags.length, 2345)
    // by id (keyset), not by offset: an item changing between pages hides none
    const ids = items.map((i) => i.id).sort()
    const periodPages = subgraph.queries.filter((q) => q.registry === REGISTRY.tokens && q.either)
    assert.deepEqual(periodPages.map((q) => q.idGt), ["", ids[999], ids[1999]])
  })

  it("rewards the latest registration's requester (an item can be removed and registered again)", async () => {
    subgraph.add(
      subgraphItem("addressTags", {
        requests: [registration(evmAddress(0x01), IN - 86400 * 40), clearing(evmAddress(0x02), IN - 86400 * 20), registration(evmAddress(0x03), IN)],
      })
    )
    const [tag] = await fetchTags(PERIOD)
    assert.equal(tag.submitter, evmAddress(0x03))
  })

  it("pays an item once, in the period its registration resolved, whatever the requests after it", async () => {
    const challengedLater = subgraphItem("tokens", { requests: [registration(evmAddress(1), IN), clearing(evmAddress(9), AFTER)] }) // removal rejected after the period
    const paidBefore = subgraphItem("tokens", { requests: [registration(evmAddress(2), BEFORE), clearing(evmAddress(9), IN)] }) // removal rejected in it
    const registeredAgain = subgraphItem("tokens", {
      requests: [registration(evmAddress(3), IN - 86400), clearing(evmAddress(9), IN), registration(evmAddress(4), AFTER)],
    }) // removed in the period, registered again after it
    subgraph.add(challengedLater, paidBefore, registeredAgain)
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => [t.id, t.submitter, t.latestRequestResolutionTime]), [[challengedLater.id, evmAddress(1), IN]])
    assert.ok(logs.has(`${paidBefore.id}: registered before the period`))
    assert.ok(logs.has(`${registeredAgain.id}: registered again after the period`))
  })

  it("flags address tags whose name ends with 'token'", async () => {
    subgraph.add(
      subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key1: "USDC Token" }),
      subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key1: "token  " }),
      subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key1: "Tokenomics Vault" }),
      subgraphItem("tokens", { requests: [registration(evmAddress(1), IN)], key1: "Some Token" })
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => t.isTokenOnAddressTags), [true, true, false, false])
  })

  it("stops on an item it cannot read or without a registration request, unless exclusions.json names it", async () => {
    const blank = subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key0: "" })
    const unrequested = subgraphItem("addressTags", { requests: [clearing(evmAddress(1), IN)] })
    subgraph.add(blank, unrequested)
    await assert.rejects(fetchTags(PERIOD), (err: Error) => {
      assert.match(err.message, /2 item\(s\) of the period cannot be read in full/)
      assert.ok(err.message.includes(`${blank.id}: its data names no IPFS file`))
      assert.ok(err.message.includes(`${unrequested.id}: the indexer has no registration request for it`))
      return true
    })
    writeFileSync(
      "exclusions.json",
      JSON.stringify([
        { itemID: blank.id, scope: "submissions", reason: "no data at all" },
        { itemID: unrequested.itemID, reason: "indexer gap, checked by hand" },
      ])
    )
    try {
      assert.deepEqual(await fetchTags(PERIOD), [])
      assert.ok(logs.has(`${blank.id} left out: its data names no IPFS file`))
      assert.ok(logs.has(`${unrequested.id} left out`))
    } finally {
      unlinkSync("exclusions.json")
    }
  })

  it("drops Domains entries whose address is live in the Tokens registry", async () => {
    const key0 = "eip155:1:0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d"
    subgraph.add(
      subgraphItem("tokens", { requests: [registration(evmAddress(1), BEFORE)], key0 }), // registered earlier
      subgraphItem("domains", { requests: [registration(evmAddress(2), IN)], key0 }),
      subgraphItem("domains", { requests: [registration(evmAddress(3), IN)], key0: "eip155:1:0x0000000000000000000000000000000000000abc" }),
      subgraphItem("tokens", { requests: [registration(evmAddress(4), BEFORE)], key0: "eip155:1:0x0000000000000000000000000000000000000def", status: "Absent" }),
      subgraphItem("domains", { requests: [registration(evmAddress(5), IN)], key0: "eip155:1:0x0000000000000000000000000000000000000def" })
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => t.submitter), [evmAddress(3), evmAddress(5)], "a removed token does not block its domain")
  })

  it("matches a Domains entry to its token whatever the letter case of an EVM address, not of a Solana one", async () => {
    const solanaMint = `solana:${SOLANA_CHAIN}:So11111111111111111111111111111111111111112`
    subgraph.add(
      subgraphItem("tokens", { requests: [registration(evmAddress(1), BEFORE)], key0: "eip155:1:0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d" }),
      subgraphItem("domains", { requests: [registration(evmAddress(2), IN)], key0: "eip155:1:0x93ED3FBe21207Ec2E8f2d3C3de6e058Cb73Bc04d" }),
      subgraphItem("domains", { requests: [registration(evmAddress(3), IN)], key0: "eip155:10:0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d" }), // another chain
      subgraphItem("tokens", { requests: [registration(evmAddress(4), BEFORE)], key0: solanaMint }),
      subgraphItem("domains", { requests: [registration(evmAddress(5), IN)], key0: solanaMint }),
      subgraphItem("domains", { requests: [registration(evmAddress(6), IN)], key0: solanaMint.replace("So111", "so111") }) // another account
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => t.submitter), [evmAddress(3), evmAddress(6)])
  })

  it("never rewards the excluded submitters, whatever the casing", async () => {
    subgraph.add(
      subgraphItem("tokens", { requests: [registration("0xf313d85c7fef79118fcd70498c71bf94e75fc2f6", IN)] }),
      subgraphItem("tokens", { requests: [registration("0xD0E76CFAA8AF741F3A8B107ECA76D393F734DACE", IN)] }),
      subgraphItem("tokens", { requests: [registration(evmAddress(9), IN)] })
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => t.submitter), [evmAddress(9)])
  })

  it("stops on an item whose registration lost its requester (the indexer's failed read), unless exclusions.json names it", async () => {
    const none = subgraphItem("tokens", { requests: [registration((null as unknown) as string, IN)] })
    const zero = subgraphItem("tokens", { requests: [registration("0x0000000000000000000000000000000000000000", IN)] })
    subgraph.add(
      none,
      zero,
      subgraphItem("tokens", { requests: [registration("0xf313d85c7fef79118fcd70498c71bf94e75fc2f6", IN)] }),
      subgraphItem("tokens", { requests: [registration(evmAddress(9), IN)] })
    )
    await assert.rejects(fetchTags(PERIOD), (err: Error) => {
      assert.ok(err.message.includes(`${none.id}: the indexer has no requester for its registration (empty)`))
      assert.ok(err.message.includes(`${zero.id}: the indexer has no requester for its registration (0x0000000000000000000000000000000000000000)`))
      return true
    })
    writeFileSync("exclusions.json", JSON.stringify([none, zero].map((i) => ({ itemID: i.itemID, scope: "submissions", reason: "requester unknown, paid by hand" }))))
    try {
      assert.deepEqual((await fetchTags(PERIOD)).map((t) => t.submitter), [evmAddress(9)], "never the zero address")
    } finally {
      unlinkSync("exclusions.json")
    }
  })

  it("aborts on an indexer error instead of paying on a partial list", async () => {
    for (let i = 0; i < 1500; i++) subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(i + 1), IN)] }))
    subgraph.fault = { graphqlErrors: true, fromRequest: 4 } // after the first pages
    await assert.rejects(fetchTags(PERIOD), /Bad subgraph response/)
    subgraph.fault = { status: 503 }
    await assert.rejects(fetchTags(PERIOD), /Subgraph HTTP 503/)
  })

  it("stops on an item key that is not a CAIP-10 address, naming it, unless exclusions.json names it", async () => {
    const bad = subgraphItem("tokens", { requests: [registration(evmAddress(1), IN)], key0: "0xnocaip" })
    subgraph.add(bad, subgraphItem("tokens", { requests: [registration(evmAddress(2), IN)] }))
    await assert.rejects(fetchTags(PERIOD), new RegExp(`${bad.id}: its key0 is not a CAIP-10 address \\("0xnocaip"\\)`))
    writeFileSync("exclusions.json", JSON.stringify([{ itemID: bad.itemID, scope: "submissions", reason: "malformed key" }]))
    try {
      assert.deepEqual((await fetchTags(PERIOD)).map((t) => t.submitter), [evmAddress(2)])
    } finally {
      unlinkSync("exclusions.json")
    }
  })
})

// The indexer leaves an item's keys empty when its one IPFS fetch failed
// (gtcr-indexer PR #11): October 2026's USD1 and ALLO went unpaid that way.
describe("items the indexer left blank", () => {
  const tokenFile = (address: string, name = "USD1") => ({
    columns: [
      { label: "Address", type: "rich address", isIdentifier: true },
      { label: "Name", type: "text", isIdentifier: true },
      { label: "Symbol", type: "text", isIdentifier: true },
      { label: "Decimals", type: "number" },
      { label: "Logo", type: "image", isIdentifier: false },
    ],
    values: { Address: address, Name: name, Symbol: name, Decimals: "6", Logo: "/ipfs/QmLogo" },
  })
  let ipfs: MockServer
  let files: { [path: string]: { status?: number; body?: unknown; raw?: string } }
  let restoreGateways: () => void
  beforeEach(async () => {
    files = {}
    ipfs = await startMockServer((req) => files[req.path] || { status: 404, body: { error: "not found" } })
    restoreGateways = setEnv({ IPFS_READ_GATEWAYS: `${ipfs.url}/ipfs` })
  })
  afterEach(async () => {
    restoreGateways()
    await ipfs.close()
  })

  it("reads a blank item's address from its IPFS file, so it is rewarded like the others", async () => {
    const usd1 = `solana:${SOLANA_CHAIN}:USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB`
    files["/ipfs/QmUsd1/item.json"] = { body: tokenFile(usd1) }
    subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(9), IN)], key0: "", key1: "", data: "/ipfs/QmUsd1/item.json" }))
    const [tag] = await fetchTags(PERIOD)
    assert.equal(tag.tagAddress, "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")
    assert.equal(tag.chain, SOLANA_CHAIN)
    assert.equal(tag.submitter, evmAddress(9))
    assert.ok(logs.has("1 item(s) without key0 in the indexer"))
  })

  it("flags a blank Address Tags entry whose name tag ends with 'token', like any other", async () => {
    files["/ipfs/QmTag"] = {
      body: {
        columns: [
          { label: "Contract Address", isIdentifier: true },
          { label: "Public Name Tag", isIdentifier: true },
          { label: "Project Name", isIdentifier: true },
        ],
        values: { "Contract Address": "eip155:1:0x00000000000000000000000000000000000000aa", "Public Name Tag": "Some Token", "Project Name": "Some" },
      },
    }
    subgraph.add(subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key0: "", key1: "", data: "/ipfs/QmTag" }))
    const [tag] = await fetchTags(PERIOD)
    assert.equal(tag.isTokenOnAddressTags, true)
    assert.equal(tag.addressTagName, "some token")
  })

  it("stops the fetch when a blank item's file cannot be read, rather than leave it unpaid", async () => {
    subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(1), IN)], key0: "", data: "/ipfs/QmGone" }))
    await assert.rejects(fetchTags(PERIOD), /its IPFS file \/ipfs\/QmGone could not be read \(http:\/\/127\.0\.0\.1:\d+\/ipfs: HTTP 404\)/)
  })

  it("stops on a blank item whose file names no address or is no JSON, unless exclusions.json names it", async () => {
    files["/ipfs/QmEmpty"] = { body: { columns: [{ label: "Address", isIdentifier: true }], values: {} } }
    files["/ipfs/QmGarbled"] = { raw: "{ not json" }
    const empty = subgraphItem("tokens", { requests: [registration(evmAddress(1), IN)], key0: "", data: "/ipfs/QmEmpty" })
    const garbled = subgraphItem("tokens", { requests: [registration(evmAddress(2), IN)], key0: "", data: "/ipfs/QmGarbled" })
    subgraph.add(empty, garbled)
    await assert.rejects(fetchTags(PERIOD), /\/ipfs\/QmEmpty names no address[\s\S]*\/ipfs\/QmGarbled could not be read \(http:\/\/127\.0\.0\.1:\d+\/ipfs: not JSON\)/)
    writeFileSync("exclusions.json", JSON.stringify([empty, garbled].map((i) => ({ itemID: i.itemID, scope: "all", reason: "malformed submission" }))))
    try {
      assert.deepEqual(await fetchTags(PERIOD), [])
    } finally {
      unlinkSync("exclusions.json")
    }
  })

  it("takes only an item file for an answer: a gateway's error page or own JSON sends it to the next gateway", async () => {
    const usd1 = `solana:${SOLANA_CHAIN}:USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB`
    restoreGateways()
    restoreGateways = setEnv({ IPFS_READ_GATEWAYS: `${ipfs.url}/html/ipfs,${ipfs.url}/own/ipfs,${ipfs.url}/ipfs` })
    files["/html/ipfs/QmUsd1"] = { raw: "<html>rate limited</html>" }
    files["/own/ipfs/QmUsd1"] = { body: { error: "context deadline exceeded" } }
    files["/ipfs/QmUsd1"] = { body: tokenFile(usd1) }
    const item = subgraphItem("tokens", { requests: [registration(evmAddress(9), IN)], key0: "", data: "/ipfs/QmUsd1" })
    subgraph.add(item)
    assert.equal((await fetchTags(PERIOD))[0].tagAddress, "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")
    delete files["/ipfs/QmUsd1"]
    await assert.rejects(fetchTags(PERIOD), /could not be read \([^)]*\/html\/ipfs: not JSON; [^;]*\/own\/ipfs: not an item file; [^;]*\/ipfs: HTTP 404\)/)
  })

  it("reads an item's data however its IPFS file is written", () => {
    const cid = "QmYkRTauLAQftN27i6EDZGWNgKHLCHYYqCPw8qPenaBNi5"
    assert.equal(ipfsPath(`/ipfs/${cid}`), cid)
    assert.equal(ipfsPath(`ipfs://${cid}/item.json`), `${cid}/item.json`)
    assert.equal(ipfsPath(`https://cdn.kleros.link/ipfs/${cid}`), cid)
    assert.equal(ipfsPath(cid), cid)
    assert.equal(ipfsPath("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
    assert.equal(ipfsPath('{"Contract Address":"eip155:10:0x9ff3"}'), null, "data written inline names no file")
    // the indexer's own forms (its extractPath)
    assert.equal(ipfsPath(`ipfs/${cid}/item.json`), `${cid}/item.json`)
    assert.equal(ipfsPath(`/${cid}/item.json`), `${cid}/item.json`)
    assert.equal(ipfsPath(`ipfs::/${cid}`), cid)
    assert.equal(ipfsPath("/ipfs/"), null)
  })

  it("keeps a live token the indexer left blank from paying its CDN entry", async () => {
    const key0 = "eip155:1:0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d"
    files["/ipfs/QmToken"] = { body: tokenFile(key0, "PNK") }
    subgraph.add(
      subgraphItem("tokens", { requests: [registration(evmAddress(1), BEFORE)], key0: "", data: "/ipfs/QmToken" }),
      subgraphItem("domains", { requests: [registration(evmAddress(2), IN)], key0 })
    )
    assert.deepEqual(await fetchTags(PERIOD), [])
  })

  it("pays the removal of an item the indexer left blank, with its address", async () => {
    files["/ipfs/QmRemoved"] = { body: tokenFile("eip155:100:0x0000000000000000000000000000000000000abc", "GNO") }
    subgraph.add(
      subgraphItem("tokens", {
        status: "Absent",
        requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(2), IN)],
        key0: "",
        data: "/ipfs/QmRemoved",
      })
    )
    const [removal] = await fetchRemovals(PERIOD)
    assert.equal(removal.tagAddress, "0x0000000000000000000000000000000000000abc")
    assert.equal(removal.chain, "100")
    assert.equal(removal.submitter, evmAddress(2))
  })

  it("derives the keys as the indexer does: identifier columns in order, values as text", () => {
    const keys = keysFromItemFile({
      columns: [
        { label: "A", isIdentifier: true },
        { label: "Skipped" },
        { label: "B", isIdentifier: true },
        { label: "C", isIdentifier: true },
        { label: "D", isIdentifier: true },
      ],
      values: { A: "eip155:1:0xabc", B: 6, C: true, Skipped: "x" },
    })
    assert.deepEqual(keys, { key0: "eip155:1:0xabc", key1: "6", key2: "true", key3: "-" })
    assert.equal(keysFromItemFile({ columns: [{ label: "A" }], values: { A: "x" } }), null)
    assert.equal(keysFromItemFile("not an item"), null)
  })
})

describe("fetchRemovals", () => {
  const removed = (registry: keyof typeof REGISTRY, requests: MockItem["requests"], overrides: Partial<MockItem> = {}) =>
    subgraphItem(registry, { status: "Absent", requests, ...overrides })

  it("rewards the requester of the winning removal, for removals resolved in the period", async () => {
    const item = removed("tokens", [registration(evmAddress(1), BEFORE), clearing(evmAddress(2), IN)], {
      key0: "eip155:100:0x0000000000000000000000000000000000000abc",
    })
    subgraph.add(item)
    const [removal] = await fetchRemovals(PERIOD)
    assert.deepEqual(removal, {
      id: item.id,
      itemID: item.itemID,
      registry: "tokens",
      chain: "100",
      chainName: "Gnosis Chain",
      submitter: evmAddress(2),
      tagAddress: "0x0000000000000000000000000000000000000abc",
      removedAt: IN,
    })
  })

  it("dates a removal by its own request, not by a later rejected re-registration", async () => {
    subgraph.add(
      removed("domains", [registration(evmAddress(1), BEFORE), clearing(evmAddress(2), IN), registration(evmAddress(3), AFTER)]),
      removed("domains", [registration(evmAddress(1), BEFORE - 9000), clearing(evmAddress(4), BEFORE), registration(evmAddress(5), IN)])
    )
    const removals = await fetchRemovals(PERIOD)
    assert.deepEqual(removals.map((r) => r.submitter), [evmAddress(2)])
  })

  it("pays a removal accepted in the period whatever the item's status at run time, and never a rejected one", async () => {
    subgraph.add(
      // removed in the period, submitted again before the run: no longer Absent
      subgraphItem("tokens", { status: "RegistrationRequested", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(2), IN), registration(evmAddress(3), 0)] }),
      // ...and registered again before the run
      subgraphItem("tokens", { status: "Registered", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(4), IN), registration(evmAddress(5), IN + 3600)] }),
      // a removal rejected in the period: the item is still registered
      subgraphItem("tokens", { status: "Registered", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(6), IN)] }),
      // rejected, then challenged again (pending): not a removal either
      subgraphItem("tokens", { status: "ClearingRequested", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(7), IN), clearing(evmAddress(8), 0)] })
    )
    assert.deepEqual((await fetchRemovals(PERIOD)).map((r) => r.submitter).sort(), [evmAddress(2), evmAddress(4)].sort())
  })

  it("ignores rejected registrations and items without a removal", async () => {
    subgraph.add(
      removed("addressTags", [registration(evmAddress(1), IN)]),
      removed("addressTags", [registration(evmAddress(1), BEFORE), registration(evmAddress(2), IN)], { numberOfRequests: 2 })
    )
    assert.deepEqual(await fetchRemovals(PERIOD), [])
  })

  it("names unrewarded chains and keeps removals on them", async () => {
    subgraph.add(removed("addressTags", [registration(evmAddress(1), BEFORE), clearing(evmAddress(2), IN)], { key0: "eip155:56:0x0000000000000000000000000000000000000001" }))
    const [removal] = await fetchRemovals(PERIOD)
    assert.equal(removal.chainName, "Binance Smart Chain")
  })

  it("stops on a removal whose requester the indexer lost (none, or the zero address), unless exclusions.json names it", async () => {
    const none = removed("tokens", [registration(evmAddress(1), BEFORE), clearing("", IN)])
    const zero = removed("domains", [registration(evmAddress(1), BEFORE), clearing("0x0000000000000000000000000000000000000000", IN)])
    subgraph.add(none, zero, removed("tokens", [registration(evmAddress(1), BEFORE), clearing(evmAddress(7), IN)]))
    await assert.rejects(fetchRemovals(PERIOD), /\[removals-fetch\] 1 item\(s\) of the period cannot be read in full[\s\S]*the indexer has no requester for its removal \(empty\)/)
    writeFileSync("exclusions.json", JSON.stringify([none, zero].map((i) => ({ itemID: i.itemID, scope: "removals", reason: "remover unknown" }))))
    try {
      assert.deepEqual((await fetchRemovals(PERIOD)).map((r) => r.submitter), [evmAddress(7)])
    } finally {
      unlinkSync("exclusions.json")
    }
  })

  it("aborts on an indexer error", async () => {
    subgraph.fault = { graphqlErrors: true }
    await assert.rejects(fetchRemovals(PERIOD), /\[removals-fetch\] Bad subgraph response/)
  })
})

describe("ATQ registrations and removals", () => {
  it("lists ATQ registrations resolved in the period, oldest first, with their metadata", async () => {
    subgraph.add(
      subgraphItem("atq", { requests: [registration(evmAddress(1), IN + 100)], key0: "0x1", key1: "Scanner", key2: "", key3: "https://x" }),
      subgraphItem("atq", { requests: [registration(evmAddress(2), IN)], key0: "0x2" }),
      subgraphItem("atq", { requests: [registration(evmAddress(3), BEFORE)] })
    )
    const rows = await fetchAtqRegistered(PERIOD)
    assert.deepEqual(rows.map((r) => r.requester), [evmAddress(2), evmAddress(1)])
    assert.equal(rows[1].metadata, "0x1 | Scanner | https://x")
    assert.equal(rows[1].submissionTime, IN + 100 - 3600)
  })

  it("lists ATQ removals resolved in the period", async () => {
    subgraph.add(
      subgraphItem("atq", { status: "Absent", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(7), IN)] }),
      subgraphItem("atq", { status: "Absent", requests: [registration(evmAddress(1), IN)] })
    )
    const rows = await fetchAtqAbsent(PERIOD)
    assert.deepEqual(rows.map((r) => r.requester), [evmAddress(7)])
  })

  it("lists an ATQ removal accepted in the period even when the item was submitted again before the run", async () => {
    subgraph.add(subgraphItem("atq", { status: "RegistrationRequested", requests: [registration(evmAddress(1), BEFORE), clearing(evmAddress(7), IN), registration(evmAddress(8), 0)] }))
    assert.deepEqual((await fetchAtqAbsent(PERIOD)).map((r) => r.requester), [evmAddress(7)])
  })

  it("lists an ATQ registration challenged since (its removal still pending)", async () => {
    subgraph.add(subgraphItem("atq", { status: "ClearingRequested", requests: [registration(evmAddress(1), IN), clearing(evmAddress(7), 0)] }))
    assert.deepEqual((await fetchAtqRegistered(PERIOD)).map((r) => r.requester), [evmAddress(1)])
  })

  it("stops on an ATQ row whose requester the indexer lost, unless exclusions.json names it", async () => {
    const zero = subgraphItem("atq", { requests: [registration("0x0000000000000000000000000000000000000000", IN)] })
    subgraph.add(zero, subgraphItem("atq", { requests: [registration(evmAddress(2), IN)] }))
    await assert.rejects(fetchAtqRegistered(PERIOD), /no requester for its registration \(0x0{40}\)[\s\S]*"scope": "atq"/)
    writeFileSync("exclusions.json", JSON.stringify([{ itemID: zero.itemID, scope: "atq", reason: "requester unknown" }]))
    try {
      assert.deepEqual((await fetchAtqRegistered(PERIOD)).map((r) => r.requester), [evmAddress(2)])
    } finally {
      unlinkSync("exclusions.json")
    }
  })
})
