import { describe, it } from "node:test"
import { strict as assert } from "assert"
import { BigNumber } from "ethers"
import { evalFormula, FormulaContext, parseRegistryFormula } from "../../src/reward-builder"

const SCALE = BigNumber.from("1000000000000000000")
const PNK = (n: number | string) => BigNumber.from(String(n)).mul(SCALE)

// Integer square root, scaled like the engine (`sqrt(x)` of a count x is
// sqrt(x) * 1e18, floored).
const scaledSqrt = (n: number): BigNumber => {
  const target = BigInt(n) * BigInt(SCALE.toString()) * BigInt(SCALE.toString())
  let x = target
  let y = (x + BigInt(1)) / BigInt(2)
  while (y < x) {
    x = y
    y = (x + target / x) / BigInt(2)
  }
  return BigNumber.from(x.toString())
}

const ctx = (overrides: Partial<FormulaContext> = {}): FormulaContext => ({
  reward_pool: PNK(1200),
  total_submissions: 3,
  txns_with_contract: 100,
  total_txns_with_all_contracts: 600,
  sum_sqrt_total_txns_with_all_contracts_scaled: scaledSqrt(100).add(scaledSqrt(200)).add(scaledSqrt(300)),
  ...overrides,
})

const run = (formula: string, context: FormulaContext = ctx()): BigNumber =>
  evalFormula("addressTags", parseRegistryFormula("addressTags", formula), context)

describe("formula engine: arithmetic", () => {
  it("evaluates the default formula: half the pool split evenly, half by transactions", () => {
    const formula =
      "(reward_pool/(2*total_submissions)) + ((reward_pool*txns_with_contract)/(2*total_txns_with_all_contracts))"
    // 1200/6 + 1200*100/1200 = 200 + 100
    assert.equal(run(formula).toString(), PNK(300).toString())
    assert.equal(run(formula, ctx({ txns_with_contract: 300 })).toString(), PNK(500).toString())
    assert.equal(run(formula, ctx({ txns_with_contract: 0 })).toString(), PNK(200).toString())
  })

  it("returns whole wei, flooring fractions", () => {
    // 1 wei pool split in 3: 0.333… wei floors to 0
    assert.equal(run("reward_pool/3", ctx({ reward_pool: BigNumber.from(1) })).toString(), "0")
    assert.equal(run("reward_pool/3", ctx({ reward_pool: BigNumber.from(10) })).toString(), "3")
    // numbers are not pool-scaled: 7/2 is 3.5, reported as 3 (whole wei of an unscaled value)
    assert.equal(run("7/2").toString(), "3")
  })

  it("applies * and / before + and -, left to right, and honours parentheses", () => {
    assert.equal(run("2+3*4").toString(), "14")
    assert.equal(run("(2+3)*4").toString(), "20")
    assert.equal(run("10-4-3").toString(), "3")
    assert.equal(run("100/10/2").toString(), "5")
    assert.equal(run("((((1))))").toString(), "1")
    assert.equal(run("  2 *\t( 3 + 4 )  ").toString(), "14")
  })

  it("reads decimal literals with up to 18 decimals", () => {
    assert.equal(run("reward_pool*0.1").toString(), PNK(120).toString())
    assert.equal(run("reward_pool*0.000000000000000001").toString(), "1200")
    assert.equal(run("reward_pool * .5").toString(), PNK(600).toString())
    assert.equal(run("reward_pool * 2.").toString(), PNK(2400).toString())
  })

  it("treats token_tx as an alias of txns_with_contract", () => {
    assert.equal(run("token_tx").toString(), run("txns_with_contract").toString())
    assert.equal(run("token_tx").toString(), "100")
  })

  it("takes square roots of counts and of the pool-scaled sums", () => {
    assert.equal(run("sqrt(txns_with_contract)").toString(), "10")
    assert.equal(run("sqrt(16) + sqrt(9)").toString(), "7")
    // sqrt(2) = 1.414…: the engine keeps 18 decimals internally
    assert.equal(run("sqrt(2) * 1000").toString(), "1414")
    // the denominator variable is already a sum of scaled square roots
    const expected = scaledSqrt(100).mul(SCALE).div(ctx().sum_sqrt_total_txns_with_all_contracts_scaled)
    assert.equal(
      run("(sqrt(token_tx)/sum_sqrt_total_txns_with_all_contracts) * 1000000000000000000").toString(),
      expected.toString()
    )
  })

  // The Tokens formula of each period: 10% by share of transactions and 90% by
  // square root until September 2026, half and half from October 2026.
  const tokensFormula = (linear: string, sqrt: string) =>
    `((token_tx/total_txns_with_all_contracts)*${linear}*reward_pool) + ((sqrt(token_tx)/sum_sqrt_total_txns_with_all_contracts)*${sqrt}*reward_pool)`
  const TOKENS_UNTIL_SEPTEMBER_2026 = tokensFormula("0.1", "0.9")
  const TOKENS_FROM_OCTOBER_2026 = tokensFormula("0.5", "0.5")
  const tokensRewards = (formula: string, counts: number[], pool: BigNumber): BigNumber[] => {
    const total = counts.reduce((a, b) => a + b, 0)
    const sumSqrt = counts.reduce((acc, c) => acc.add(scaledSqrt(c)), BigNumber.from(0))
    return counts.map((count) =>
      run(
        formula,
        ctx({
          reward_pool: pool,
          total_submissions: counts.length,
          txns_with_contract: count,
          total_txns_with_all_contracts: total,
          sum_sqrt_total_txns_with_all_contracts_scaled: sumSqrt,
        })
      )
    )
  }

  it("evaluates the Tokens formula so that the shares of a registry add up to the pool", () => {
    for (const formula of [TOKENS_UNTIL_SEPTEMBER_2026, TOKENS_FROM_OCTOBER_2026]) {
      const pool = PNK(3000)
      const sum = tokensRewards(formula, [1, 4, 9, 16, 1000000], pool).reduce((acc, r) => acc.add(r), BigNumber.from(0))
      assert.ok(sum.lte(pool), "floor division never hands out more than the pool")
      assert.ok(pool.sub(sum).lt(1000000), `only rounding dust may remain, got ${pool.sub(sum).toString()} wei`)
    }
  })

  it("weighs transactions and their square root 10/90 until September 2026, 50/50 from October", () => {
    // 1 and 9 transactions: shares 10% and 90%, square-root shares 1/4 and 3/4
    const pool = PNK(1000)
    assert.deepEqual(tokensRewards(TOKENS_UNTIL_SEPTEMBER_2026, [1, 9], pool), [PNK(235), PNK(765)]) // 0.1·10% + 0.9·25%
    assert.deepEqual(tokensRewards(TOKENS_FROM_OCTOBER_2026, [1, 9], pool), [PNK(175), PNK(825)]) // 0.5·10% + 0.5·25%
  })
})

describe("formula engine: rejected formulas", () => {
  const rejects = (formula: string, message: RegExp, context: FormulaContext = ctx()) =>
    assert.throws(() => run(formula, context), message)

  it("rejects unknown names and characters, naming the registry", () => {
    rejects("reward_pool * bonus", /Unknown identifier "bonus" in formula for addressTags/)
    rejects("reward_pool % 2", /Invalid character "%" in formula for addressTags/)
    rejects("log(token_tx)", /Unknown identifier "log"/)
  })

  it("rejects malformed numbers", () => {
    rejects("1.2.3", /Invalid numeric literal "1\.2\.3"/)
    rejects(".", /Invalid numeric literal "\."/)
    rejects("0.0000000000000000001", /more than 18 decimal places/)
  })

  it("rejects unbalanced parentheses and incomplete expressions", () => {
    rejects("(reward_pool", /Unmatched "\("/)
    rejects("reward_pool)", /Unmatched "\)"/)
    rejects("", /is empty/)
    rejects("   ", /is empty/)
    rejects("reward_pool +", /Invalid formula/)
    rejects("2 3", /Invalid formula/)
    rejects("sqrt()", /Invalid formula/)
    rejects("-1", /Invalid formula/) // no unary minus
  })

  it("refuses a division by zero and a negative intermediate result", () => {
    rejects("reward_pool / total_txns_with_all_contracts", /division by zero/, ctx({ total_txns_with_all_contracts: 0 }))
    rejects("3 - 5", /negative intermediate result/)
  })
})
