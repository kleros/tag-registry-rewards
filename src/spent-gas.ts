import fetch from "node-fetch"
import { load } from "cheerio"

const randomBetween = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min))

export const sleep = () => {
  const seconds = randomBetween(2, 5)
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export const classicFetch = async (url: string): Promise<string | null> => {
  const response = await fetch(url)
  // thread 40654 returns code 524 after 90s wtf
  if (response.status === 404 || response.status === 524) return null
  const buffer = await response.arrayBuffer()
  const decoder = new TextDecoder("utf-8")
  const decoded = decoder.decode(buffer)

  return decoded
}

export const fetchPage = async (address: string): Promise<string | null> => {
  const etherscanQuery = `https://etherscan.io/address-analytics?&a=${address}`
  const response = await classicFetch(etherscanQuery)
  return response
}

export const getSpentGas = async (address: string): Promise<number> => {
  let page = await fetchPage(address)
  for (let i = 0; i < 5; i++) {
    if (page === null) {
      await sleep()
      page = await fetchPage(address)
    }
  }
  if (page === null) throw new Error("Etherscan refuses to return page")
  const $ = load(page)
  const feesTab = $("div #txfees")
  const feesDiv = $("div .row.mx-gutters-md-2", feesTab)
  const feesUsedDiv = $("div .col-md-6.u-ver-divider", feesDiv)
  const ethDiv = $("div .text-secondary.mb-1", feesUsedDiv)
  const ethUsed = Number(ethDiv.text().slice(0, -4))

  return ethUsed
}
