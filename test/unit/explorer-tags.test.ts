import { afterEach, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import {
  CANARIES,
  checkExplorerTags,
  evaluateBlockscoutTags,
  explorerAddressUrl,
  ExplorerItem,
  isKlerosSourced,
  parseEtherscanAddressPage,
} from "../../src/utils/explorer-tags"

// The explorer-tag check against pages and answers as the explorers gave them
// on 2026-10-13 (markup trimmed to what matters). Its HTTP and pauses are
// swapped through their modules' exports (CommonJS reads them at call time).
const http = require("../../src/utils/http")
const sender = require("../../src/transaction-sender")

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const page = (title: string, body = "") => `<html><head><title>\n\t${title}\n</title></head><body>${body}</body></html>`
const addressTitle = (address: string, explorer = "Etherscan", tag = "") =>
  `${tag ? `${tag} | ` : ""}Address: ${address.slice(0, 10)}...${address.slice(-9)} | ${explorer}`
// a public name tag with a website link (Circle: USDC Token on etherscan.io)
const TAG_WITH_LINK =
  `<a href='https://www.circle.com/' title='Public Name Tag (viewable by anyone) <br/> Circle: USDC Token&#10;(${USDC})'>` +
  "<div class='d-flex align-items-center gap-1'><i class='fas fa-tag text-muted'></i>" +
  "<span class='hash-tag text-truncate lh-sm my-n1'>Circle: USDC Token</span></div></a>"
// one without (an explorer's own phishing tag on snowscan.xyz)
const TAG_WITHOUT_LINK =
  "<span class='badge bg-light' data-bs-toggle='tooltip' title='Public Name Tag (viewable by anyone) <br/> Fake_Phishing7579937'>" +
  "<div class='d-flex align-items-center gap-1'><i class='fas fa-tag text-muted'></i>" +
  "<span class='hash-tag text-truncate lh-sm my-n1'>Fake_Phishing7579937</span></div></span>"
// labels and the EIP-7702 badge: the same span, no tooltip of a name tag
const LABELS = "<span class='hash-tag text-truncate  lh-sm my-n1'>DEX</span><span class='hash-tag text-truncate  lh-sm my-n1'>Uniswap</span>"
const AUTHORITY =
  '<span title="This EIP-7702 Authority address has delegated its execution rights to another address.">' +
  '<div class="d-flex align-items-center gap-1"><span class="hash-tag text-truncate  lh-sm my-n1">Authority</span></div></span>'

const klerosTag = (url: string) => ({ name: "WXDAI Token", tagType: "name", meta: JSON.stringify({ tagUrl: url, tooltipUrl: "https://www.gnosis.io/" }) })

describe("explorer tags: an Etherscan-built address page", () => {
  it("finds a public name tag, with or without a website link", () => {
    const linked = parseEtherscanAddressPage(page(addressTitle(USDC, "Etherscan", "Circle: USDC Token"), TAG_WITH_LINK), USDC)
    assert.deepEqual([linked.tagged, linked.names], [true, ["Circle: USDC Token"]])
    const phishing = "0x1c27fd71f6d4d51886867c09a6fea5dfdf3e6fc5"
    const plain = parseEtherscanAddressPage(page(addressTitle(phishing, "SnowScan"), TAG_WITHOUT_LINK), phishing)
    assert.deepEqual([plain.tagged, plain.names], [true, ["Fake_Phishing7579937"]])
  })

  it("takes labels and the EIP-7702 Authority badge for what they are: no name tag", () => {
    const wallet = "0xa197d5bf2cfee1c4891474d0cc353ec05f063a2f"
    assert.equal(parseEtherscanAddressPage(page(addressTitle(wallet, "BaseScan"), AUTHORITY + LABELS), wallet).tagged, false)
  })

  it("cannot tell from a challenge, or from a page that is not this address's", () => {
    assert.equal(parseEtherscanAddressPage(page("Just a moment..."), USDC).tagged, null)
    assert.equal(parseEtherscanAddressPage(page("Base Account (Invalid Address) | BaseScan"), USDC).tagged, null)
    assert.equal(parseEtherscanAddressPage(page(addressTitle("0x5b43453fce04b92e190f391a83136bfbecedefd1"), TAG_WITH_LINK), USDC).tagged, null)
  })
})

describe("explorer tags: Blockscout's metadata", () => {
  it("counts visible name tags, not labels, hidden tags or Blockscout's copies of Kleros Scout entries", () => {
    assert.deepEqual(evaluateBlockscoutTags([{ name: "Gnosis: xDai Bridge", tagType: "name", meta: '{"tooltipUrl":"https://xdaichain.com/"}' }]).names, ["Gnosis: xDai Bridge"])
    const labels = evaluateBlockscoutTags([
      { name: "Bridge", tagType: "generic", meta: "{}" },
      { name: "Gnosis", tagType: "protocol", meta: "{}" },
      { name: "Old", tagType: "name", meta: '{"hidden":"true"}' },
    ])
    assert.equal(labels.tagged, false)
    const kleros = evaluateBlockscoutTags([
      klerosTag("https://scout-app.kleros.io/single-tags/0x386b1ce3"),
    ])
    assert.deepEqual([kleros.tagged, kleros.ignored], [false, ["WXDAI Token"]])
  })

  it("recognises a Kleros Scout entry in either link the service hands out, and nothing else as one", () => {
    assert.ok(isKlerosSourced(klerosTag("https://scout-app.kleros.io/single-tags/0x386b")))
    assert.ok(isKlerosSourced(klerosTag("https://app.klerosscout.eth.limo/#/?registry=Single_Tags&itemdetails=0x386b@0x6626")))
    assert.ok(!isKlerosSourced(klerosTag("https://kleros.io")), "a Kleros contract's own tag is a tag")
    assert.ok(!isKlerosSourced({ name: "x", tagType: "name", meta: "not json" }))
  })
})

describe("explorer tags: reading the explorers", () => {
  type Answer = { status?: number; body?: string; headers?: { [h: string]: string }; url?: string } | Error
  let answers: (url: string) => Answer
  let requests: string[]
  let realFetch: unknown
  let realSleep: unknown
  // Each explorer's canary (an address known to carry a name tag) is read
  // first; unless a test says otherwise, it reads as tagged.
  let canariesTagged: boolean
  const canaryOf = (url: string): string | undefined => {
    const m = /^https:\/\/([^/]+)\/address\/(0x[0-9a-f]{40})$/.exec(url)
    return m && CANARIES[m[1]] && CANARIES[m[1]].toLowerCase() === m[2] ? m[2] : undefined
  }
  const withCanaries = (url: string, a: Answer): Answer => {
    if (!canariesTagged || a instanceof Error || (a.status || 200) !== 200) return a
    const canary = canaryOf(url)
    if (canary) return { body: page(addressTitle(canary), TAG_WITH_LINK) }
    if (!url.startsWith("https://metadata.services.blockscout.com/")) return a
    const asked = (/addresses=([^&]+)/.exec(url) as RegExpExecArray)[1].split(",")
    const canaries = Object.values(CANARIES).map((c) => c.toLowerCase())
    const body = JSON.parse(a.body || "{}")
    for (const c of asked.filter((x) => canaries.includes(x))) {
      if (!Object.keys(body.addresses || {}).some((k) => k.toLowerCase() === c)) {
        body.addresses = { ...(body.addresses || {}), [c]: { tags: [{ name: "Known tag", tagType: "name", meta: "{}" }] } }
      }
    }
    return { ...a, body: JSON.stringify(body) }
  }
  beforeEach(() => {
    requests = []
    canariesTagged = true
    realFetch = http.httpFetch
    realSleep = sender.sleep
    sender.sleep = async () => undefined
    http.httpFetch = async (url: string) => {
      requests.push(url)
      const a = withCanaries(url, answers(url))
      if (a instanceof Error) throw a
      const body = a.body || ""
      return {
        status: a.status || 200,
        url: a.url || url,
        headers: { get: (h: string) => (a.headers || {})[h.toLowerCase()] || null },
        text: async () => body,
        json: async () => JSON.parse(body),
      }
    }
  })
  afterEach(() => {
    http.httpFetch = realFetch
    sender.sleep = realSleep
  })
  const item = (key: string, host: string, address: string, chainId = "1"): ExplorerItem => ({ key, host, chainId, address })

  it("reads each address once per explorer, and every explorer at once", async () => {
    answers = (url) => ({ body: page(addressTitle(USDC), url.toLowerCase().includes(USDC.toLowerCase()) ? TAG_WITH_LINK : "") })
    const out = await checkExplorerTags([
      item("a", "etherscan.io", USDC),
      item("b", "etherscan.io", USDC.toLowerCase()),
      item("c", "basescan.org", USDC, "8453"),
    ])
    assert.deepEqual([out.get("a")!.tagged, out.get("b")!.tagged, out.get("c")!.tagged], [true, true, true])
    assert.equal(requests.length, 3, "etherscan's canary is USDC itself; basescan's canary, then USDC")
    assert.equal(out.get("a")!.url, `https://etherscan.io/address/${USDC.toLowerCase()}`)
  })

  it("stops reading an explorer that shuts scripts out, and leaves its entries for a check by hand", async () => {
    answers = (url) =>
      url.startsWith("https://arbiscan.io/")
        ? { status: 403, body: page("Just a moment..."), headers: { "cf-mitigated": "challenge" } }
        : { body: page(addressTitle("0x0000000000000000000000000000000000000001")) }
    const out = await checkExplorerTags([
      item("a", "arbiscan.io", "0x0000000000000000000000000000000000000001", "42161"),
      item("b", "arbiscan.io", "0x0000000000000000000000000000000000000002", "42161"),
      item("c", "etherscan.io", "0x0000000000000000000000000000000000000001"),
    ])
    assert.equal(out.get("a")!.tagged, null)
    assert.equal(out.get("b")!.tagged, null)
    assert.match(out.get("b")!.detail, /arbiscan\.io shuts scripts out/)
    assert.equal(requests.filter((u) => u.includes("arbiscan")).length, 1, "one request, not one per entry")
    assert.equal(out.get("c")!.tagged, false)
  })

  it("retries a page once after a rate limit or a failure, then cannot tell", async () => {
    let calls = 0
    answers = () => (++calls === 1 ? { status: 429, body: "slow down" } : { body: page(addressTitle(USDC), TAG_WITH_LINK) })
    assert.equal((await checkExplorerTags([item("a", "etherscan.io", USDC)])).get("a")!.tagged, true)
    answers = () => new Error("socket hang up")
    const failed = (await checkExplorerTags([item("a", "etherscan.io", USDC)])).get("a")!
    assert.equal(failed.tagged, null)
    assert.match(failed.detail, /could not load the page: socket hang up/)
  })

  it("asks Blockscout for many addresses at once, by chain id", async () => {
    const tagged = "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d"
    const imported = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"
    const untagged = "0x08c620ab0db1e87c5dd75e8a0ec44042c2dc2cb7"
    answers = () => ({
      body: JSON.stringify({
        addresses: {
          [tagged]: { tags: [{ name: "Gnosis: xDai Bridge", tagType: "name", meta: "{}" }] },
          [imported]: { tags: [klerosTag("https://app.klerosscout.eth.limo/#/?registry=Single_Tags&itemdetails=0x386b@0x6626")] },
        },
      }),
    })
    const out = await checkExplorerTags([
      item("a", "gnosis.blockscout.com", tagged, "100"),
      item("b", "gnosis.blockscout.com", imported, "100"),
      item("c", "gnosis.blockscout.com", untagged, "100"),
    ])
    assert.deepEqual(["a", "b", "c"].map((k) => out.get(k)!.tagged), [true, false, false])
    assert.equal(requests.length, 1)
    assert.match(requests[0], /^https:\/\/metadata\.services\.blockscout\.com\/api\/v1\/metadata\?addresses=0x[0-9a-f]{40},0x[0-9a-f]{40},0x[0-9a-f]{40}&chainId=100$/)
  })

  it("reads nothing from an explorer whose known name tag no longer reads as tagged (its pages changed)", async () => {
    canariesTagged = false
    answers = (url) => ({ body: page(addressTitle(url.slice(-42))) }) // a page without any name tag
    const out = await checkExplorerTags([
      item("a", "etherscan.io", "0x0000000000000000000000000000000000000001"),
      item("b", "etherscan.io", "0x0000000000000000000000000000000000000002"),
    ])
    assert.deepEqual([out.get("a")!.tagged, out.get("b")!.tagged], [null, null])
    assert.match(out.get("a")!.detail, /etherscan\.io does not read as expected: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, which carries a name tag, read as untagged/)
    assert.equal(requests.length, 1, "only the canary was read")
    answers = () => ({ body: JSON.stringify({ addresses: {} }) }) // Blockscout knows no tags any more
    const blockscout = await checkExplorerTags([item("c", "gnosis.blockscout.com", "0x0000000000000000000000000000000000000003", "100")])
    assert.equal(blockscout.get("c")!.tagged, null)
    assert.match(blockscout.get("c")!.detail, /gnosis\.blockscout\.com does not read as expected/)
  })

  it("cannot tell when Blockscout's metadata service fails, after one retry", async () => {
    answers = () => ({ status: 502, body: "bad gateway" })
    const out = await checkExplorerTags([item("a", "zksync.blockscout.com", USDC, "324")])
    assert.equal(out.get("a")!.tagged, null)
    assert.equal(requests.length, 2)
  })

  it("leaves Solscan, which has no keyless way, for a check by hand without asking it", async () => {
    answers = () => {
      throw new Error("not called")
    }
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const out = await checkExplorerTags([item("a", "solscan.io", mint, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")])
    assert.deepEqual([out.get("a")!.tagged, out.get("a")!.url], [null, explorerAddressUrl("solscan.io", mint)])
    assert.equal(out.get("a")!.url, `https://solscan.io/account/${mint}`)
    assert.equal(requests.length, 0)
  })
})
