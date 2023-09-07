import fetch from "node-fetch"
import { load } from "cheerio"
import { Tag } from "./types"

const randomBetween = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min))

export const sleep = (seconds = 0): Promise<void> => {
  if (seconds === 0) seconds = randomBetween(2, 5)
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export const classicFetch = async (url: string): Promise<string | null> => {
  const response = await fetch(url)
  if (response.status === 404 || response.status === 524) return null
  const buffer = await response.arrayBuffer()
  const decoder = new TextDecoder("utf-8")
  const decoded = decoder.decode(buffer)

  return decoded
}

const fetchPage = async (tag: Tag): Promise<string | null> => {
  const explorer = {
    "1": "https://etherscan.io/address-analytics?&a=",
    "56": "https://bscscan.com/address-analytics?&a=",
    "137": "https://polygonscan.com/address-analytics?&a=",
  }
  const etherscanQuery = explorer[tag.chain] + tag.tagAddress
  const response = await classicFetch(etherscanQuery)
  return response
}

// const getGnosisGas = async (address: string): Promise<number> => {
//   const subgraphQuery = {
//     query: `{
//       address(hash: "${address}") {
//         gasUsed
//       }
//     }
//     `,
//   }

//   console.log(subgraphQuery)
//   const response = await fetch("https://gnosis.blockscout.com/api/v1/graphql", {
//     method: "POST",
//     body: JSON.stringify(subgraphQuery),
//   })

//   const json = await response.json()
//   console.log(json.errors, json.errors[0].locations)
//   const gas: number = json.data.address.gasUsed
//   return gas
// }

const getMainnetGas = async (tag: Tag): Promise<number> => {
  let page: string | null = null
  for (let i = 0; i < 5; i++) {
    if (page === null) {
      await sleep()
      page = await fetchPage(tag)
    }
  }
  if (page === null) throw new Error("Explorer refuses to return page")
  const $ = load(page)
  const feesTab = $("div #txfees")
  const feesDiv = $("div .row.mx-gutters-md-2", feesTab)
  const feesUsedDiv = $("div .col-md-6.u-ver-divider", feesDiv)
  const ethDiv = $("div .text-muted.mb-1", feesUsedDiv)
  const ethUsed = Number(ethDiv.text().slice(0, -4))

  return ethUsed
}

const getPolygonGas = async (tag: Tag): Promise<number> => {
  let page: string | null = null
  for (let i = 0; i < 5; i++) {
    if (page === null) {
      await sleep()
      page = await fetchPage(tag)
    }
  }
  if (page === null) throw new Error("Explorer refuses to return page")
  const $ = load(page)
  const feesTab = $("div #txfees")
  const feesDiv = $("div .row.mx-gutters-md-2", feesTab)
  const feesUsedDiv = $("div .col-md-6.u-ver-divider", feesDiv)
  // only difference for now, kept on diff functions for the time being
  const ethDiv = $("div .text-secondary.mb-1", feesUsedDiv)

  const ethUsed = Number(ethDiv.text().slice(0, -6)) // " MATIC"

  return ethUsed
}

//
export const getSpentGas = async (tag: Tag): Promise<number> => {
  if (tag.chain === 137) {
    return getPolygonGas(tag)
  } else if (tag.chain === 1) {
    return getMainnetGas(tag)
  } else {
    throw new Error("Cannot get spent gas from this chain!")
  }
}
