import { generateContractInfos } from "./contract-info"
import { ContractInfo, GasDune, Reward, Tag } from "./types"
import { BigNumber } from "ethers"
import { humanizeAmount } from "./transaction-sender"
import { formatEther } from "ethers/lib/utils"
import conf from "./config"

const FORMULA_SCALE = BigNumber.from("1000000000000000000")
const SOLANA_CHAIN_ID = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

type RegistryKey = Tag["registry"]

type RegistryFormula = {
  raw: string
  rpn: FormulaRpnToken[]
}

type RegistryRedistributionMode = {
  redistributeCapped: boolean
}

type FormulaIdentifier =
  | "reward_pool"
  | "total_submissions"
  | "token_tx"
  | "txns_with_contract"
  | "total_txns_with_all_contracts"
  | "sum_sqrt_total_txns_with_all_contracts"

type FormulaFunction = "sqrt"

type FormulaToken =
  | {
      type: "number"
      value: string
    }
  | {
      type: "identifier"
      value: FormulaIdentifier
    }
  | {
      type: "operator"
      value: "+" | "-" | "*" | "/"
    }
  | {
      type: "function"
      value: FormulaFunction
    }
  | {
      type: "paren"
      value: "(" | ")"
    }

type FormulaRpnToken =
  | {
      type: "number"
      value: string
    }
  | {
      type: "identifier"
      value: FormulaIdentifier
    }
  | {
      type: "operator"
      value: "+" | "-" | "*" | "/"
    }
  | {
      type: "function"
      value: FormulaFunction
    }

type FormulaContext = {
  reward_pool: BigNumber
  total_submissions: number
  txns_with_contract: number
  total_txns_with_all_contracts: number
  sum_sqrt_total_txns_with_all_contracts_scaled: BigNumber
}

const formulaIdentifierSet = new Set<FormulaIdentifier>([
  "reward_pool",
  "total_submissions",
  "token_tx",
  "txns_with_contract",
  "total_txns_with_all_contracts",
  "sum_sqrt_total_txns_with_all_contracts",
])

const formulaFunctionSet = new Set<FormulaFunction>(["sqrt"])

const tokenizeFormula = (
  registry: RegistryKey,
  formula: string
): FormulaToken[] => {
  const tokens: FormulaToken[] = []
  let i = 0

  while (i < formula.length) {
    const ch = formula[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (/[0-9.]/.test(ch)) {
      let j = i
      let dotCount = 0
      while (j < formula.length && /[0-9.]/.test(formula[j])) {
        if (formula[j] === ".") dotCount++
        j++
      }
      const rawNumber = formula.slice(i, j)
      if (dotCount > 1 || rawNumber === ".") {
        throw new Error(
          `Invalid numeric literal "${rawNumber}" in formula for ${registry}.`
        )
      }
      tokens.push({ type: "number", value: rawNumber })
      i = j
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < formula.length && /[A-Za-z0-9_]/.test(formula[j])) j++
      const rawIdentifier = formula.slice(i, j)
      if (formulaIdentifierSet.has(rawIdentifier as FormulaIdentifier)) {
        tokens.push({
          type: "identifier",
          value: rawIdentifier as FormulaIdentifier,
        })
        i = j
        continue
      }
      if (formulaFunctionSet.has(rawIdentifier as FormulaFunction)) {
        tokens.push({
          type: "function",
          value: rawIdentifier as FormulaFunction,
        })
        i = j
        continue
      }
      if (
        !formulaIdentifierSet.has(rawIdentifier as FormulaIdentifier) &&
        !formulaFunctionSet.has(rawIdentifier as FormulaFunction)
      ) {
        throw new Error(
          `Unknown identifier "${rawIdentifier}" in formula for ${registry}. Allowed identifiers: reward_pool, total_submissions, token_tx, txns_with_contract, total_txns_with_all_contracts, sum_sqrt_total_txns_with_all_contracts. Allowed functions: sqrt(...).`
        )
      }
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({
        type: "operator",
        value: ch as "+" | "-" | "*" | "/",
      })
      i++
      continue
    }

    if (ch === "(" || ch === ")") {
      tokens.push({
        type: "paren",
        value: ch as "(" | ")",
      })
      i++
      continue
    }

    throw new Error(
      `Invalid character "${ch}" in formula for ${registry}. Use only numbers, identifiers, + - * /, and parentheses.`
    )
  }

  if (tokens.length === 0) {
    throw new Error(`Formula for ${registry} is empty.`)
  }

  return tokens
}

const precedence: { [key in "+" | "-" | "*" | "/"]: number } = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
}

const toRpn = (registry: RegistryKey, tokens: FormulaToken[]): FormulaRpnToken[] => {
  const output: FormulaRpnToken[] = []
  const operators: FormulaToken[] = []

  for (const token of tokens) {
    if (token.type === "number" || token.type === "identifier") {
      output.push(token)
      continue
    }

    if (token.type === "function") {
      operators.push(token)
      continue
    }

    if (token.type === "operator") {
      while (operators.length > 0) {
        const top = operators[operators.length - 1]
        if (
          top.type === "operator" &&
          precedence[top.value] >= precedence[token.value]
        ) {
          output.push(operators.pop() as FormulaRpnToken)
          continue
        }
        break
      }
      operators.push(token)
      continue
    }

    if (token.value === "(") {
      operators.push(token)
      continue
    }

    let matched = false
    while (operators.length > 0) {
      const top = operators.pop() as FormulaToken
      if (top.type === "paren" && top.value === "(") {
        matched = true
        if (
          operators.length > 0 &&
          operators[operators.length - 1].type === "function"
        ) {
          output.push(operators.pop() as FormulaRpnToken)
        }
        break
      }
      output.push(top as FormulaRpnToken)
    }
    if (!matched) {
      throw new Error(`Unmatched ")" in formula for ${registry}.`)
    }
  }

  while (operators.length > 0) {
    const top = operators.pop() as FormulaToken
    if (top.type === "paren") {
      throw new Error(`Unmatched "(" in formula for ${registry}.`)
    }
    output.push(top as FormulaRpnToken)
  }

  return output
}

const decimalLiteralToScaled = (literal: string): BigNumber => {
  const parts = literal.split(".")
  const intPart = parts[0] || "0"
  const fracRaw = parts[1] || ""
  if (fracRaw.length > 18) {
    throw new Error(
      `Decimal literal "${literal}" has more than 18 decimal places.`
    )
  }
  const fracPart = fracRaw.padEnd(18, "0")
  const normalized = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "")
  return BigNumber.from(normalized === "" ? "0" : normalized)
}

const integerSqrt = (n: bigint): bigint => {
  const TWO = BigInt("2")
  if (n < TWO) return n
  let x0 = n
  let x1 = (x0 + n / x0) / TWO
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + n / x0) / TWO
  }
  return x0
}

const scaledSqrt = (scaledValue: BigNumber): BigNumber => {
  if (scaledValue.isNegative()) {
    throw new Error("Cannot compute sqrt of a negative number.")
  }
  const scaleBigInt = BigInt(FORMULA_SCALE.toString())
  const n = BigInt(scaledValue.toString()) * scaleBigInt
  const root = integerSqrt(n)
  return BigNumber.from(root.toString())
}

const scaledSqrtFromInteger = (value: number): BigNumber => {
  const scaled = BigNumber.from(value).mul(FORMULA_SCALE)
  return scaledSqrt(scaled)
}

const formulaValueFromIdentifier = (
  identifier: FormulaIdentifier,
  ctx: FormulaContext
): BigNumber => {
  if (identifier === "reward_pool") {
    return ctx.reward_pool.mul(FORMULA_SCALE)
  }
  if (identifier === "total_submissions") {
    return BigNumber.from(ctx.total_submissions).mul(FORMULA_SCALE)
  }
  if (identifier === "txns_with_contract" || identifier === "token_tx") {
    return BigNumber.from(ctx.txns_with_contract).mul(FORMULA_SCALE)
  }
  if (identifier === "total_txns_with_all_contracts") {
    return BigNumber.from(ctx.total_txns_with_all_contracts).mul(FORMULA_SCALE)
  }
  return ctx.sum_sqrt_total_txns_with_all_contracts_scaled
}

const evalFormula = (
  registry: RegistryKey,
  formula: RegistryFormula,
  ctx: FormulaContext
): BigNumber => {
  const stack: BigNumber[] = []
  for (const token of formula.rpn) {
    if (token.type === "number") {
      stack.push(decimalLiteralToScaled(token.value))
      continue
    }
    if (token.type === "identifier") {
      stack.push(formulaValueFromIdentifier(token.value, ctx))
      continue
    }
    if (token.type === "function") {
      if (stack.length < 1) {
        throw new Error(`Invalid formula for ${registry}: "${formula.raw}"`)
      }
      const value = stack.pop() as BigNumber
      if (token.value === "sqrt") {
        stack.push(scaledSqrt(value))
        continue
      }
    }

    if (stack.length < 2) {
      throw new Error(`Invalid formula for ${registry}: "${formula.raw}"`)
    }
    const right = stack.pop() as BigNumber
    const left = stack.pop() as BigNumber

    if (token.value === "+") {
      stack.push(left.add(right))
    } else if (token.value === "-") {
      if (left.lt(right)) {
        throw new Error(
          `Formula for ${registry} produced a negative intermediate result.`
        )
      }
      stack.push(left.sub(right))
    } else if (token.value === "*") {
      stack.push(left.mul(right).div(FORMULA_SCALE))
    } else {
      if (right.isZero()) {
        throw new Error(
          `Formula for ${registry} attempted division by zero. Check total_txns_with_all_contracts and total_submissions.`
        )
      }
      stack.push(left.mul(FORMULA_SCALE).div(right))
    }
  }

  if (stack.length !== 1) {
    throw new Error(`Invalid formula for ${registry}: "${formula.raw}"`)
  }

  return stack[0].div(FORMULA_SCALE)
}

const parseRegistryFormula = (
  registry: RegistryKey,
  rawFormula: string
): RegistryFormula => {
  const formula = rawFormula.trim()
  const tokens = tokenizeFormula(registry, formula)
  const rpn = toRpn(registry, tokens)
  return { raw: formula, rpn }
}

const getRegistryFormulas = (): Record<RegistryKey, RegistryFormula> => ({
  addressTags: parseRegistryFormula(
    "addressTags",
    conf.REWARD_FORMULA_ADDRESS_TAGS
  ),
  tokens: parseRegistryFormula("tokens", conf.REWARD_FORMULA_TOKENS),
  domains: parseRegistryFormula("domains", conf.REWARD_FORMULA_DOMAINS),
})

const parseBooleanToggle = (registry: RegistryKey, key: string, raw: string): boolean => {
  const value = raw.trim().toLowerCase()
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(
    `Invalid value for ${key} (${registry}): "${raw}". Expected true or false.`
  )
}

const getRegistryRedistributionModes = (): Record<
  RegistryKey,
  RegistryRedistributionMode
> => ({
  addressTags: {
    redistributeCapped: parseBooleanToggle(
      "addressTags",
      "REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS",
      conf.REWARD_REDISTRIBUTE_CAPPED_ADDRESS_TAGS
    ),
  },
  tokens: {
    redistributeCapped: parseBooleanToggle(
      "tokens",
      "REWARD_REDISTRIBUTE_CAPPED_TOKENS",
      conf.REWARD_REDISTRIBUTE_CAPPED_TOKENS
    ),
  },
  domains: {
    redistributeCapped: parseBooleanToggle(
      "domains",
      "REWARD_REDISTRIBUTE_CAPPED_DOMAINS",
      conf.REWARD_REDISTRIBUTE_CAPPED_DOMAINS
    ),
  },
})

const getSolanaTxDivider = (): number => {
  const raw = conf.SOLANA_TX_DIVIDER
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(
      `Invalid SOLANA_TX_DIVIDER="${raw}". Expected a number >= 1.`
    )
  }
  return value
}

const contractInfosToRewards = (
  contractInfos: ContractInfo[],
  stipend: BigNumber,
  maxReward: BigNumber,
  formula: RegistryFormula,
  redistributionMode: RegistryRedistributionMode,
  registryName?: RegistryKey
): Reward[] => {
  // base case
  if (contractInfos.length === 0) return []
  const registryLabel = registryName ? ` (${registryName} registry)` : ""
  console.log(
    `pending recursion... ${contractInfos.length} submissions${registryLabel}, stipend remaining:`,
    formatEther(stipend.toString())
  )
  const counter = { itemCount: 0, txCount: 0 }
  for (const ci of contractInfos) {
    counter.itemCount++
    counter.txCount += ci.txCount
  }

  const sumSqrtTotalTxnsWithAllContractsScaled = contractInfos.reduce(
    (acc, info) => acc.add(scaledSqrtFromInteger(info.txCount)),
    BigNumber.from(0)
  )

  const rewards = contractInfos.map((ci) => {
    // Preserve legacy behavior when all tx counts are zero.
    const totalReward =
      counter.txCount === 0
        ? stipend.div(BigNumber.from(counter.itemCount))
        : evalFormula(registryName || ci.registry, formula, {
            reward_pool: stipend,
            total_submissions: counter.itemCount,
            txns_with_contract: ci.txCount,
            total_txns_with_all_contracts: counter.txCount,
            sum_sqrt_total_txns_with_all_contracts_scaled:
              sumSqrtTotalTxnsWithAllContractsScaled,
          })
    const reward: Reward = {
      id: ci.id,
      amount: totalReward,
      recipient: ci.submitter,
      contractInfo: ci,
    }
    return reward
  })

  const excessiveRewards = rewards.filter((r) => r.amount.gte(maxReward))
  if (excessiveRewards.length === 0) return rewards

  if (!redistributionMode.redistributeCapped) {
    return rewards.map((r) =>
      r.amount.gte(maxReward)
        ? {
            ...r,
            amount: maxReward,
          }
        : r
    )
  }
  // console.log("still excessive:", excessiveRewards.length)
  // put in a bag all contractInfos whose id is not found in excessiveRewards
  // if [], that base case is covered
  const lessAwardedContracts = contractInfos.filter(
    (ci) => !excessiveRewards.find((r) => r.id === ci.id)
  )
  // console.log("pending", lessAwardedContracts.length)
  // put in a bag all excessive rewards, capped to maxReward
  const cappedRewards = excessiveRewards.map((r) => ({
    ...r,
    amount: maxReward,
  }))
  // recompute this function, with the subset of less awarded contracts, and less stipend
  const newStipend = stipend.sub(
    maxReward.mul(BigNumber.from(cappedRewards.length))
  )
  const lesserRewards = contractInfosToRewards(
    lessAwardedContracts,
    newStipend,
    maxReward,
    formula,
    redistributionMode,
    registryName
  )
  return [...cappedRewards, ...lesserRewards]
}

export const buildRewards = async (
  stipend: BigNumber,
  maxReward: BigNumber,
  tags: Tag[],
  gasDunes: GasDune[]
): Promise<Reward[]> => {
  console.log("Generating rewards for", humanizeAmount(stipend), "PNK")
  const formulas = getRegistryFormulas()
  const redistributionModes = getRegistryRedistributionModes()
  const solanaTxDivider = getSolanaTxDivider()
  const contractInfosRaw = generateContractInfos(tags, gasDunes)
  const contractInfos =
    solanaTxDivider === 1
      ? contractInfosRaw
      : contractInfosRaw.map((ci) => {
          if (ci.chain !== SOLANA_CHAIN_ID) return ci
          return {
            ...ci,
            txCount: Math.floor(ci.txCount / solanaTxDivider),
          }
        })

  if (solanaTxDivider !== 1) {
    console.log(
      `[generate] Applied SOLANA_TX_DIVIDER=${solanaTxDivider} to Solana entries before formula evaluation.`
    )
  }

  const tagRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "addressTags"),
    stipend,
    maxReward,
    formulas.addressTags,
    redistributionModes.addressTags,
    "addressTags"
  )
  const tokensRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "tokens"),
    stipend,
    maxReward,
    formulas.tokens,
    redistributionModes.tokens,
    "tokens"
  )
  const domainsRewards = contractInfosToRewards(
    contractInfos.filter((ci) => ci.registry === "domains"),
    stipend,
    maxReward,
    formulas.domains,
    redistributionModes.domains,
    "domains"
  )
  const rewards = [...tagRewards, ...tokensRewards, ...domainsRewards]
  let sum = BigNumber.from(0)
  for (const reward of rewards) {
    sum = sum.add(reward.amount)
  }
  console.log("Final PNK stipend", sum.toString())
  return rewards
}
