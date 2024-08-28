import fetch from "node-fetch"

// For scraping Etherscan explorers to figure out if an address' "name tag" is already tagged on etherscan
export async function isTaggedOnEtherscan(
  etherscanHostname: string,
  address: string
): Promise<boolean> {
  const url = `https://${etherscanHostname}/address/${address}`
  console.log(url)

  const options = {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  }

  try {
    // Fetch the web page
    const response = await fetch(url, options)
    const html = await response.text()

    // Log the fetched HTML length for debugging
    // console.log("Fetched HTML length:", html.length)
    // console.log(html.slice(27000))

    // Initialize regexPattern as a string
    let regexPattern: string
    if (etherscanHostname === "arbiscan.io") {
      regexPattern = "anyone\\)'>(.*?)<\\/span>"
    } else {
      regexPattern =
        '<span\\s+class="hash-tag\\s+text-truncate\\s+lh-sm\\s+my-n1">(.*?)<\\/span>'
    }

    console.log(`Hostname: ${etherscanHostname} and regex is ${regexPattern}`)

    // Convert regexPattern string to RegExp
    const regex = new RegExp(regexPattern, "im")

    // Apply the regex to the HTML
    const match = regex.exec(html)

    if (match && match[1]) {
      const elementContent = match[1].trim()
      console.log("Extracted Content:", elementContent)
      return true
    } else {
      console.log("Element not found or regex didn't match")
      return false
    }
  } catch (error) {
    console.log("Error fetching the web page:", error)
    return false
  }
}
