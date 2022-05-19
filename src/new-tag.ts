import { load } from "cheerio"
import { classicFetch, sleep } from "./spent-gas"

const fetchPage = async (address: string): Promise<string | null> => {
  const etherscanQuery = `https://etherscan.io/address/${address}`
  const response = await classicFetch(etherscanQuery)
  return response
}

export const isNewTag = async (address: string): Promise<boolean> => {
  let page = await fetchPage(address)
  for (let i = 0; i < 5; i++) {
    if (page === null) {
      await sleep()
      page = await fetchPage(address)
    }
  }
  if (page === null) throw new Error("Etherscan refuses to return page")
  const $ = load(page)
  const publicNoteDiv = $("div .alert.alert-info")
  if (!publicNoteDiv.html()) return false
  const text = publicNoteDiv.text()
  console.log("text from newtag:", text)
  const test = /Submitted by Kleros Curate/.test(text)
  return test
}
