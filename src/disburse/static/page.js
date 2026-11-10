/* global module */
/*
 * The disburse page's logic, apart from the page itself (main.js draws it), so
 * that the suite runs this very code in Node against a stand-in wallet and the
 * real server (test/integration/disburse-page.test.ts). A plain script: the
 * browser loads it as window.DisbursePage, Node as a CommonJS module.
 *
 * The page decides nothing about what is paid: the server (session.ts) checks
 * every payout with send's own rules and hands out one transfer at a time. The
 * page holds each one against the plan the check showed (a row of it, not paid
 * then, not handed out before in this run), makes sure the wallet is still on
 * the paying account and chain with nothing pending, hands the wallet that
 * transaction, built here from the checked plan alone, and reports what the
 * wallet answered.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory()
  else root.DisbursePage = factory()
})(typeof self !== "undefined" ? self : this, function () {
  "use strict"

  var TRANSFER = "0xa9059cbb" // transfer(address,uint256)

  // An amount of wei as PNK, with thousands separators and `decimals` decimals.
  function formatPnk(wei, decimals) {
    var places = decimals === undefined ? 2 : decimals
    var value = BigInt(wei)
    var scale = BigInt(10) ** BigInt(18 - places)
    var rounded = (value + scale / BigInt(2)) / scale // to `places` decimals
    var whole = rounded / BigInt(10) ** BigInt(places)
    var fraction = (rounded % BigInt(10) ** BigInt(places)).toString().padStart(places, "0")
    var grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    return places > 0 ? grouped + "." + fraction : grouped
  }

  // An amount of wei as PNK to the last wei, as a device shows it: every
  // decimal it has, none more ("6,999.999999999999999992", "500").
  function formatPnkExact(wei) {
    var value = BigInt(wei)
    var unit = BigInt(10) ** BigInt(18)
    var whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    var fraction = (value % unit).toString().padStart(18, "0").replace(/0+$/, "")
    return fraction ? whole + "." + fraction : whole
  }

  // The calldata of transfer(recipient, amount).
  function transferData(recipient, amount) {
    var to = String(recipient).toLowerCase().replace(/^0x/, "")
    if (!/^[0-9a-f]{40}$/.test(to)) throw new Error("Not an address: " + recipient)
    return TRANSFER + to.padStart(64, "0") + BigInt(amount).toString(16).padStart(64, "0")
  }

  // The server's API. `origin` is for Node, where fetch sends none by itself.
  function createApi(options) {
    var call = async function (path, body) {
      var headers = { "Content-Type": "application/json", "X-Disburse-Session": options.token }
      if (options.origin) headers.Origin = options.origin
      var response = await options.fetch((options.base || "") + path, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body || {}),
      })
      var json
      try {
        json = await response.json()
      } catch (error) {
        throw new Error("The page's server answered HTTP " + response.status + ": is `yarn start --mode disburse-page` still running?")
      }
      if (!json.ok) throw Object.assign(new Error(json.error), { refused: !!json.refused })
      return json.result
    }
    return {
      overview: function () { return call("/api/overview") },
      check: function (body) { return call("/api/check", body) },
      next: function (body) { return call("/api/next", body) },
      sent: function (body) { return call("/api/sent", body) },
      receipt: function (body) { return call("/api/receipt", body) },
      rejected: function (body) { return call("/api/rejected", body) },
      failed: function (body) { return call("/api/failed", body) },
      recordHash: function (body) { return call("/api/record-hash", body) },
      forget: function (body) { return call("/api/forget", body) },
    }
  }

  var sameAddress = function (a, b) { return String(a).toLowerCase() === String(b).toLowerCase() }

  /*
   * The page's session: Check, then Disburse, which runs only right after a
   * Check that no change of the wallet's account or chain interrupted, and
   * hands the wallet one transfer at a time until every chosen payout is paid
   * or something stops it. `options`: wallet (EIP-1193), api, chainId, payer
   * (SEND_FROM, or null), events ({ voided, asking, sent, unverified, waiting,
   * confirmed, stopped, done }), sleep (for the suite).
   */
  function createController(options) {
    var wallet = options.wallet
    var api = options.api
    var events = options.events || {}
    var sleep = options.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
    var emit = function (name) {
      var args = Array.prototype.slice.call(arguments, 1)
      if (events[name]) events[name].apply(null, args)
    }
    var checked = null // the last check, while it may be used
    var expected = null // the account and chain it was made for
    var changes = 0
    var running = false
    var stopAfter = false

    // Any change of the wallet's account or chain voids the check, except one
    // onto what the check asked for (it switches the chain itself).
    ;["accountsChanged", "chainChanged"].forEach(function (event) {
      if (!wallet || typeof wallet.on !== "function") return
      wallet.on(event, function (value) {
        var onto =
          event === "chainChanged"
            ? Number(value) === options.chainId
            : expected && Array.isArray(value) && value[0] && sameAddress(value[0], expected.account)
        if (onto) return
        changes += 1
        if (checked) {
          checked = null
          emit("voided", event)
        }
        if (running) stopAfter = true
      })
    })

    // The wallet on the paying account and chain, with nothing of the account's
    // pending on the wallet's own node (a node a block behind ours may still show
    // the last transfer pending for a moment: asked again for a while).
    async function walletReady(account) {
      var accounts = await wallet.request({ method: "eth_requestAccounts" })
      var selected = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null
      if (!selected) throw new Error("The wallet gave no account: unlock it and select the paying account")
      if (options.payer && !sameAddress(selected, options.payer)) {
        throw new Error("The wallet's account is " + selected + ", not " + options.payer + " (SEND_FROM): select it in the wallet")
      }
      if (account && !sameAddress(selected, account)) throw new Error("The wallet's account changed since the check: Check again")
      var walletChain = Number(await wallet.request({ method: "eth_chainId" }))
      if (walletChain !== options.chainId) {
        try {
          await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + options.chainId.toString(16) }] })
        } catch (error) {
          if (error && error.code === 4902) {
            throw new Error("The wallet doesn't have chain " + options.chainId + ": add it to the wallet, then Check again")
          }
          throw error
        }
        walletChain = Number(await wallet.request({ method: "eth_chainId" }))
        if (walletChain !== options.chainId) throw new Error("The wallet is on chain " + walletChain + ", not " + options.chainId)
      }
      for (var tries = 0; ; tries++) {
        var counts = await Promise.all(
          ["latest", "pending"].map(function (tag) {
            return wallet.request({ method: "eth_getTransactionCount", params: [selected, tag] })
          })
        )
        var pending = BigInt(counts[1]) - BigInt(counts[0])
        if (pending <= BigInt(0)) break
        if (tries >= 15) {
          throw new Error("The wallet's node shows " + pending + " transaction(s) of " + selected + " pending: wait until they are mined, then Check again")
        }
        await sleep(2000)
      }
      return selected
    }

    // The step is one of the checked plan's transfers, not paid when checked
    // and not handed out before in this run, and its transaction is exactly
    // that transfer: from the account, to PNK, transfer(recipient, amount), no
    // value, the chain's id. Returns the transaction to hand the wallet, built
    // from the plan: nothing else the server sent goes to the wallet.
    function verifyStep(plan, step, handed) {
      var payout = plan.payouts.filter(function (p) { return p.kind === step.kind && !p.refusal })[0]
      var row = payout && payout.transfers[step.index]
      if (!row || !sameAddress(row.recipient, step.recipient) || row.amount !== step.amount) {
        throw new Error("The server asked for a transfer that is not in the checked plan")
      }
      if (row.status === "confirmed") throw new Error("The server asked for a transfer the check showed as paid already")
      var key = step.kind + ":" + step.index
      if (handed[key]) throw new Error("The server asked for a transfer handed to the wallet already in this run")
      var tx = step.tx || {}
      if (!sameAddress(tx.from, plan.account)) throw new Error("The transfer would be sent from " + tx.from + ", not " + plan.account)
      if (!sameAddress(tx.to, plan.token)) throw new Error("The transfer would be sent to " + tx.to + ", not PNK " + plan.token)
      if (String(tx.data).toLowerCase() !== transferData(step.recipient, step.amount)) throw new Error("The transfer's data is not transfer(recipient, amount)")
      if (tx.value !== "0x0") throw new Error("The transfer would carry a value")
      if (Number(tx.chainId) !== plan.chainId) throw new Error("The transfer is for chain " + Number(tx.chainId) + ", not " + plan.chainId)
      handed[key] = true
      return {
        from: plan.account,
        to: plan.token,
        data: transferData(row.recipient, row.amount),
        value: "0x0",
        chainId: "0x" + plan.chainId.toString(16),
      }
    }

    // `extra`: { unrelatedTxs, skipPaidOnChain }, send's --unrelated-tx and
    // --skip-paid-on-chain for the transfers the check finds on-chain.
    async function check(folder, kinds, extra) {
      if (running) throw new Error("Disbursing right now: stop it first")
      checked = null
      expected = null
      var account = await walletReady(null)
      expected = { account: account }
      var before = changes
      var options = extra || {}
      var result = await api.check({
        folder: folder,
        kinds: kinds,
        account: account,
        unrelatedTxs: options.unrelatedTxs || [],
        skipPaidOnChain: !!options.skipPaidOnChain,
      })
      if (changes !== before) throw new Error("The wallet's account or chain changed during the check: Check again")
      if (result.checkId) checked = result
      return result
    }

    // Runs the checked plan: every transfer of it, one at a time.
    async function disburse() {
      if (running) throw new Error("Disbursing already")
      if (!checked || !checked.checkId) throw new Error("Check first")
      var plan = checked
      checked = null // a check is used once
      var handed = {} // the rows handed to the wallet in this run
      running = true
      stopAfter = false
      emit("running", true)
      try {
        for (;;) {
          var step = await api.next({ checkId: plan.checkId })
          if (step.state === "done") {
            emit("done", step)
            return step
          }
          var tx
          try {
            tx = verifyStep(plan, step, handed)
            await walletReady(plan.account)
          } catch (error) {
            // the wallet was never asked: nothing was sent
            var cleared = await api.rejected({ requestId: step.requestId })
            emit("stopped", error.message + (cleared.state === "cleared" ? "" : ". " + cleared.message))
            return null
          }
          emit("asking", step)
          var hash
          try {
            hash = await wallet.request({ method: "eth_sendTransaction", params: [tx] })
          } catch (error) {
            if (error && error.code === 4001) {
              var rejected = await api.rejected({ requestId: step.requestId })
              emit("stopped", rejected.message)
              return null
            }
            var failed = await api.failed({ requestId: step.requestId, message: (error && error.message) || String(error) })
            emit("stopped", failed.message)
            return null
          }
          if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            var odd = await api.failed({ requestId: step.requestId, message: "the wallet answered " + hash + " instead of a transaction hash" })
            emit("stopped", odd.message)
            return null
          }
          var sent
          for (var tries = 0; ; tries++) {
            sent = await api.sent({ requestId: step.requestId, hash: hash })
            if (sent.state === "sent") break
            if (tries >= 90) {
              var unseen = await api.failed({ requestId: step.requestId, message: "the RPC never showed " + hash + " (3 minutes)" })
              emit("stopped", unseen.message)
              return null
            }
            emit("unverified", step, hash)
            await sleep(2000)
          }
          emit("sent", step, sent)
          var receipt
          var since = Date.now()
          for (;;) {
            receipt = await api.receipt({ requestId: step.requestId }) // the server waits a while for it
            if (receipt.state !== "pending") break
            emit("waiting", step, receipt, Math.floor((Date.now() - since) / 60000))
          }
          if (receipt.state !== "confirmed") {
            emit("stopped", receipt.message)
            return null
          }
          emit("confirmed", step, receipt)
          if (stopAfter) {
            emit("stopped", "Stopped after this transfer: Check again, then Disburse, for the rest")
            return null
          }
        }
      } catch (error) {
        // a refusal of the server, or it unreachable: the ledger holds where it stopped
        var message = (error && error.message) || String(error)
        emit("stopped", /Check again/.test(message) ? message : message + ". Check again: it settles whatever is with the wallet.")
        return null
      } finally {
        running = false
        emit("running", false)
      }
    }

    return {
      check: check,
      disburse: disburse,
      // Stops after the transfer with the wallet now, never in the middle of one.
      stop: function () { stopAfter = true },
      // Drops the check (another folder or other payouts chosen): Check again.
      invalidate: function () { checked = null },
      canDisburse: function () { return !running && !!(checked && checked.checkId) },
      isRunning: function () { return running },
      recordHash: function (body) { return api.recordHash(body) },
      forget: function (body) { return api.forget(body) },
    }
  }

  return {
    createApi: createApi,
    createController: createController,
    formatPnk: formatPnk,
    formatPnkExact: formatPnkExact,
    transferData: transferData,
  }
})
