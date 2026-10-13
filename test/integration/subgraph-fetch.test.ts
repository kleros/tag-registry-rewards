import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { fetchTags } from "../../src/tag-fetch"
import { fetchAtqAbsent, fetchAtqRegistered, fetchRemovals } from "../../src/removals-fetch"
import { captureConsole, CapturedConsole } from "../support/console"
import { setEnv } from "../support/env"
import { evmAddress, REGISTRY, SOLANA_CHAIN, unix } from "../support/fixtures"
import { MockItem, MockSubgraph, subgraphItem } from "../support/subgraph"

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

describe("fetchTags", () => {
  it("returns the live items of the three registries registered in the period", async () => {
    const tag = subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key0: "eip155:8453:0xAbC0000000000000000000000000000000000001", key1: "Uniswap Router" })
    const token = subgraphItem("tokens", { requests: [registration(evmAddress(2), IN)], status: "ClearingRequested", key0: `solana:${SOLANA_CHAIN}:So11111111111111111111111111111111111111112` })
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
      isTokenOnAddressTags: false,
      addressTagName: "uniswap router",
    })
    assert.equal(tags[1].chain, SOLANA_CHAIN)
    assert.equal(tags[1].addressTagName, "")
    const windows = subgraph.queries.filter((q) => q.gte !== undefined)
    assert.ok(windows.every((q) => q.gte === unix("2026-09-01T00:00:00Z") && q.lt === unix("2026-10-01T00:00:00Z")))
  })

  it("pages through registries of more than 1,000 items", async () => {
    for (let i = 0; i < 2345; i++) subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(i + 10), IN)] }))
    const tags = await fetchTags(PERIOD)
    assert.equal(tags.length, 2345)
    assert.deepEqual(
      subgraph.queries.filter((q) => q.registry === REGISTRY.tokens).map((q) => q.offset),
      [0, 1000, 2000]
    )
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

  it("skips items without key0 or without a registration request, with a warning", async () => {
    subgraph.add(
      subgraphItem("addressTags", { requests: [registration(evmAddress(1), IN)], key0: "" }),
      subgraphItem("addressTags", { requests: [clearing(evmAddress(1), IN)] })
    )
    assert.deepEqual(await fetchTags(PERIOD), [])
    assert.ok(logs.has("missing key0"))
    assert.ok(logs.has("no registration request found"))
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

  it("keeps an item whose registration lost its requester instead of failing the fetch", async () => {
    subgraph.add(
      subgraphItem("tokens", { requests: [registration((null as unknown) as string, IN)] }),
      subgraphItem("tokens", { requests: [registration("0xf313d85c7fef79118fcd70498c71bf94e75fc2f6", IN)] }),
      subgraphItem("tokens", { requests: [registration(evmAddress(9), IN)] })
    )
    const tags = await fetchTags(PERIOD)
    assert.deepEqual(tags.map((t) => t.submitter), [null, evmAddress(9)])
  })

  it("aborts on an indexer error instead of paying on a partial list", async () => {
    for (let i = 0; i < 1500; i++) subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(i + 1), IN)] }))
    subgraph.fault = { graphqlErrors: true, fromRequest: 4 } // after the first pages
    await assert.rejects(fetchTags(PERIOD), /Bad subgraph response/)
    subgraph.fault = { status: 503 }
    await assert.rejects(fetchTags(PERIOD), /Subgraph HTTP 503/)
  })

  it("rejects an item key that is not a CAIP-10 address", async () => {
    subgraph.add(subgraphItem("tokens", { requests: [registration(evmAddress(1), IN)], key0: "0xnocaip" }))
    await assert.rejects(fetchTags(PERIOD), /Invalid CAIP string received: "0xnocaip"/)
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

  it("skips, loudly, a removal whose requester the indexer lost", async () => {
    subgraph.add(removed("tokens", [registration(evmAddress(1), BEFORE), clearing("", IN)]))
    assert.deepEqual(await fetchRemovals(PERIOD), [])
    assert.ok(logs.has(/has no requester on its ClearingRequested/))
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
})
