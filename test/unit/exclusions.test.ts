import { after, before, beforeEach, describe, it } from "node:test"
import { strict as assert } from "assert"
import { writeFileSync } from "fs"
import { join } from "path"
import {
  applyAtqExclusions,
  applyRemovalExclusions,
  applyTagExclusions,
  loadExclusions,
  warnUnmatchedExclusions,
} from "../../src/utils/exclusions"
import { captureConsole, CapturedConsole } from "../support/console"
import { withEnv } from "../support/env"
import { freshWorkdir, writeJson } from "../support/files"
import { evmAddress, makeAtqRow, makeRemoval, makeTag, REGISTRY, SOLANA_CHAIN, solanaAddress } from "../support/fixtures"

let logs: CapturedConsole
before(() => {
  logs = captureConsole()
})
after(() => logs.restore())
beforeEach(() => {
  freshWorkdir() // exclusions.json is read from the working directory
  logs.clear()
})

const write = (entries: unknown) => writeJson("exclusions.json", entries)

describe("loadExclusions", () => {
  it("is empty without a file", () => {
    assert.deepEqual(loadExclusions().entries, [])
  })

  it("loads the documented example file", () => {
    writeFileSync("exclusions.json", require("fs").readFileSync(join(__dirname, "..", "..", "exclusions.example.json")))
    const list = loadExclusions()
    assert.equal(list.entries.length, 6)
    assert.ok(logs.has("[exclusions] Loaded 6 entrie(s) from exclusions.json"))
    assert.deepEqual(
      list.entries.map((e) => e.label),
      [
        "0x0000000000000000000000000000000000000001 (chain 1) [addressTags]",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA (chain 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp) [tokens]",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003 (chain 42161) [domains]",
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        "0x0000000000000000000000000000000000000000000000000000000000000005",
      ]
    )
    assert.ok(list.entries.every((e) => e.hits === 0))
  })

  it("aborts on a malformed file, naming the problem", () => {
    const cases: [unknown, RegExp][] = [
      [{ not: "an array" }, /must be a JSON array/],
      [[42], /exclusions\.json\[0\] is not an object/],
      [[{ tagAddress: "0x1" }], /\[0\] needs a non-empty "reason"/],
      [[{ tagAddress: "0x1", reason: "   " }], /needs a non-empty "reason"/],
      [[{ reason: "why" }], /needs "tagAddress" and\/or "itemID"/],
      [[{ tagAddress: "0x1", reason: "x", scope: "everything" }], /invalid scope "everything"/],
      [[{ tagAddress: "0x1", reason: "x", registry: "atq" }], /invalid registry "atq"/],
      [[{ tagAddress: "0x1", reason: "x", scope: "atq" }], /scope "atq", which matches by "itemID" only/],
    ]
    for (const [content, message] of cases) {
      write(content)
      assert.throws(() => loadExclusions(), message)
    }
    writeFileSync("exclusions.json", "[{ broken")
    assert.throws(() => loadExclusions(), /Could not parse exclusions\.json as JSON/)
  })

  it("reads EXCLUSIONS_FILE instead when set (at startup)", async () => {
    const path = require.resolve("../../src/utils/exclusions")
    await withEnv({ EXCLUSIONS_FILE: "elsewhere.json" }, () => {
      delete require.cache[path]
      try {
        writeJson("elsewhere.json", [{ tagAddress: "0x1", reason: "moved" }])
        const fresh = require(path)
        assert.equal(fresh.EXCLUSIONS_PATH, "elsewhere.json")
        assert.equal(fresh.loadExclusions().entries.length, 1)
      } finally {
        delete require.cache[path]
      }
    })
  })
})

describe("applyTagExclusions", () => {
  it("drops tags by address, case-insensitively, narrowed by chain and registry", () => {
    const address = "0xAbC0000000000000000000000000000000000001"
    const hit = makeTag({ tagAddress: address.toLowerCase(), chain: "1", registry: "addressTags" })
    const otherChain = makeTag({ tagAddress: address, chain: "10", registry: "addressTags" })
    const otherRegistry = makeTag({ tagAddress: address, chain: "1", registry: "tokens" })
    write([{ tagAddress: address, chain: "1", registry: "addressTags", reason: "already tagged" }])
    const list = loadExclusions()
    const kept = applyTagExclusions(list, [hit, otherChain, otherRegistry])
    assert.deepEqual(kept, [otherChain, otherRegistry])
    assert.equal(list.entries[0].hits, 1)
    assert.ok(logs.has(`[exclusions] Dropping submissions ${hit.tagAddress} (chain 1) [addressTags] — already tagged`))
  })

  it("matches every chain and registry when they are omitted", () => {
    const address = evmAddress(0xbad)
    write([{ tagAddress: address, reason: "spam" }])
    const kept = applyTagExclusions(loadExclusions(), [
      makeTag({ tagAddress: address, chain: "1" }),
      makeTag({ tagAddress: address, chain: "8453", registry: "domains" }),
      makeTag(),
    ])
    assert.equal(kept.length, 1)
  })

  it("matches a Solana address and chain", () => {
    const address = solanaAddress("Excluded")
    write([{ tagAddress: address, chain: SOLANA_CHAIN, registry: "tokens", reason: "x" }])
    const kept = applyTagExclusions(loadExclusions(), [makeTag({ tagAddress: address, chain: SOLANA_CHAIN, registry: "tokens" })])
    assert.deepEqual(kept, [])
  })

  it("matches an item by its bare itemID or its <itemID>@<registry> id", () => {
    const itemID = "0x" + "ab".repeat(32)
    const tag = makeTag({ id: `${itemID}@${REGISTRY.addressTags}` })
    write([{ itemID: itemID.toUpperCase().replace("0X", "0x"), reason: "bare" }])
    assert.deepEqual(applyTagExclusions(loadExclusions(), [tag]), [])
    write([{ itemID: `${itemID}@${REGISTRY.addressTags}`, reason: "full id" }])
    assert.deepEqual(applyTagExclusions(loadExclusions(), [tag]), [])
  })

  it("ignores entries scoped to removals or ATQ", () => {
    const address = evmAddress(0x77)
    write([{ tagAddress: address, scope: "removals", reason: "removal only" }])
    const tag = makeTag({ tagAddress: address })
    assert.deepEqual(applyTagExclusions(loadExclusions(), [tag]), [tag])
  })

  it("credits every matching entry, so overlapping entries do not warn as unmatched", () => {
    const address = evmAddress(0x88)
    write([
      { tagAddress: address, reason: "first" },
      { tagAddress: address, chain: "1", reason: "second" },
    ])
    const list = loadExclusions()
    applyTagExclusions(list, [makeTag({ tagAddress: address, chain: "1" })])
    assert.deepEqual(list.entries.map((e) => e.hits), [1, 1])
  })
})

describe("applyRemovalExclusions and applyAtqExclusions", () => {
  it("drops removals by address or by item", () => {
    const byAddress = makeRemoval({ tagAddress: evmAddress(0x99), chain: "42161", registry: "domains" })
    const byItem = makeRemoval({ itemID: "0x" + "cd".repeat(32) })
    const kept = makeRemoval()
    write([
      { tagAddress: evmAddress(0x99), chain: "42161", registry: "domains", scope: "removals", reason: "self-removal" },
      { itemID: byItem.itemID, scope: "all", reason: "bogus" },
    ])
    assert.deepEqual(applyRemovalExclusions(loadExclusions(), [byAddress, byItem, kept]), [kept])
  })

  it("does not apply submission-scoped entries to removals", () => {
    const removal = makeRemoval({ tagAddress: evmAddress(0x42) })
    write([{ tagAddress: evmAddress(0x42), scope: "submissions", reason: "x" }])
    assert.deepEqual(applyRemovalExclusions(loadExclusions(), [removal]), [removal])
  })

  it("drops ATQ rows by itemID only", () => {
    const row = makeAtqRow({ itemID: "0x" + "ef".repeat(32) })
    write([{ itemID: row.itemID, scope: "atq", reason: "duplicate" }])
    const list = loadExclusions()
    assert.deepEqual(applyAtqExclusions(list, [row, makeAtqRow()], "registered").length, 1)
    assert.ok(logs.has(`[exclusions] Dropping atq registered ${row.itemID} — duplicate`))
  })
})

describe("warnUnmatchedExclusions", () => {
  it("warns about an entry that matched nothing in the run's scopes", () => {
    write([{ tagAddress: evmAddress(0x1), scope: "submissions", reason: "typo?" }])
    const list = loadExclusions()
    warnUnmatchedExclusions(list, ["submissions"])
    assert.ok(logs.has(/WARNING: entry .* \(typo\?\) matched nothing — check for typos/))
  })

  it("explains that a scope:all entry may match in another mode", () => {
    write([{ tagAddress: evmAddress(0x2), reason: "all modes" }])
    const list = loadExclusions()
    warnUnmatchedExclusions(list, ["submissions"])
    assert.ok(logs.has(/matched nothing in this run \(checked: submissions\)\. Scope is "all"/))
    logs.clear()
    warnUnmatchedExclusions(list, ["submissions", "removals", "atq"])
    assert.ok(logs.has(/matched nothing — check for typos/), "--mode all checks every kind, so it is exact")
  })

  it("stays quiet for entries that matched, or that the run did not cover", () => {
    write([
      { tagAddress: evmAddress(0x3), scope: "removals", reason: "not this run" },
      { tagAddress: evmAddress(0x4), reason: "matched" },
    ])
    const list = loadExclusions()
    applyTagExclusions(list, [makeTag({ tagAddress: evmAddress(0x4) })])
    logs.clear()
    warnUnmatchedExclusions(list, ["submissions"])
    assert.equal(logs.lines.length, 0)
  })
})
