import { Server } from "http"
import { acquireDisbursementLock, disbursementsDir, displayPath } from "../utils/disbursement-ledger"
import { sendChainId, sendRpcUrl, sendTokenAddress } from "../utils/send-chain"
import { chainDisplayName } from "../utils/chains"
import { createDisburseServer, disbursePagePort } from "./server"
import { DisburseSession, pinnedPayer } from "./session"

// `--mode disburse-page`: serves the disburse page on 127.0.0.1 until Ctrl-C,
// holding the ledger's lock all along (no `--mode send` meanwhile), for the
// browser wallet that pays the rewards. Returns the server once listening.
export const disbursePageRoutine = async (): Promise<Server> => {
  const chainId = sendChainId()
  const token = sendTokenAddress()
  sendRpcUrl(chainId) // an RPC for the chain, or stop here
  const payer = pinnedPayer()
  const release = acquireDisbursementLock()
  const session = new DisburseSession()
  const { server, token: key } = createDisburseServer(session)
  const port = disbursePagePort()
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      release()
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is taken: stop what holds it (another disburse page?), or set DISBURSE_PAGE_PORT`)
          : error
      )
    })
    server.listen(port, "127.0.0.1", () => resolve())
  })
  server.on("close", release)
  console.log(`Serving the disburse page until Ctrl-C. Open this link (the part after # is this run's key; share it with no one):`)
  console.log(`  http://127.0.0.1:${port}/#${key}`)
  console.log(`  Network: ${chainDisplayName(String(chainId))} (${chainId}), PNK ${token}`)
  console.log(`  Paying account: ${payer ? `${payer} (SEND_FROM)` : "whichever the wallet has selected (SEND_FROM pins one)"}`)
  console.log(`  Ledger: ${displayPath(disbursementsDir())} (locked meanwhile: no --mode send)`)
  console.log("Open it in the browser that has the wallet (Rabby, MetaMask, …). Commit disbursements/ once done.")
  return server
}
