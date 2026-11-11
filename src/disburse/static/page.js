/* global module */
/*
 * The disburse page's logic, apart from the page itself (main.js draws it), so
 * that the suite runs this very code in Node against a stand-in wallet and the
 * real server (test/integration/disburse-page.test.ts). A plain script: the
 * browser loads it as window.DisbursePage, Node as a CommonJS module.
 *
 * The page decides nothing about what is paid: the server (session.ts) checks
 * every payout with send's own rules and hands out what to send: one transfer
 * at a time, or, through Disperse, an approval of the exact total and then one
 * batch of every transfer. The page holds each step against the plan the
 * check showed (its rows not paid then, not handed out before in this run),
 * makes sure the wallet is still on the paying account and chain with nothing
 * pending, hands the wallet the transaction, built here from the checked plan
 * alone, and reports what the wallet answered.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory()
  else root.DisbursePage = factory()
})(typeof self !== "undefined" ? self : this, function () {
  "use strict"

  var TRANSFER = "0xa9059cbb" // transfer(address,uint256)
  var APPROVE = "0x095ea7b3" // approve(address,uint256)
  var DISPERSE_TOKEN_SIMPLE = "0x51ba162c" // disperseTokenSimple(address,address[],uint256[])
  // Disperse (disperse.app): the only contract this page pays through, wherever
  // the server says it is.
  var DISPERSE = "0xd152f549545093347a162dce210e7293f1452150"

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

  // ABI words: an address, and an unsigned integer.
  function addressWord(address) {
    var a = String(address).toLowerCase().replace(/^0x/, "")
    if (!/^[0-9a-f]{40}$/.test(a)) throw new Error("Not an address: " + address)
    return a.padStart(64, "0")
  }
  function uintWord(value) {
    var v = BigInt(value)
    if (v < BigInt(0) || v >= BigInt(2) ** BigInt(256)) throw new Error("Not a uint256: " + value)
    return v.toString(16).padStart(64, "0")
  }

  // The calldata of transfer(recipient, amount).
  function transferData(recipient, amount) {
    return TRANSFER + addressWord(recipient) + uintWord(amount)
  }

  // The calldata of approve(spender, amount).
  function approveData(spender, amount) {
    return APPROVE + addressWord(spender) + uintWord(amount)
  }

  // The calldata of Disperse's disperseTokenSimple(token, recipients, amounts).
  function disperseData(token, recipients, amounts) {
    if (recipients.length !== amounts.length) throw new Error("As many amounts as recipients are needed")
    var n = recipients.length
    var head = addressWord(token) + uintWord(96) + uintWord(96 + 32 * (n + 1))
    return (
      DISPERSE_TOKEN_SIMPLE +
      head +
      uintWord(n) +
      recipients.map(addressWord).join("") +
      uintWord(n) +
      amounts.map(uintWord).join("")
    )
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
      if (response.status === 403) {
        throw new Error(
          "The page's server refused this page (HTTP 403): open the whole link the terminal printed for this run " +
            "(its key, after #, changes every time the page is started)"
        )
      }
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
      nextBatch: function (body) { return call("/api/next-batch", body) },
      recordHash: function (body) { return call("/api/record-hash", body) },
      forget: function (body) { return call("/api/forget", body) },
    }
  }

  var sameAddress = function (a, b) { return String(a).toLowerCase() === String(b).toLowerCase() }

  /*
   * The page's session: Check, then Disburse, which runs only right after a
   * Check that no change of the wallet's account or chain interrupted, and
   * hands the wallet one transfer at a time until every chosen payout is paid
   * or something stops it. `options`: wallet (EIP-1193), api, chainId, token
   * (PNK's address, from the overview), payer (SEND_FROM, or null), events
   * ({ running, voided, asking, sent, unverified, waiting, confirmed, stopped,
   * done }), sleep (for the suite).
   */
  function createController(options) {
    var wallet = options.wallet
    var api = options.api
    var events = options.events || {}
    var sleep = options.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
    var emit = function (name) {
      var args = Array.prototype.slice.call(arguments, 1)
      try {
        if (events[name]) events[name].apply(null, args)
      } catch (error) {
        // drawing the page must never break the run's bookkeeping
        if (typeof console !== "undefined") console.error(error)
      }
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
      if (step.state !== "send") throw new Error("The server asked for a " + step.state + " step, not a transfer")
      var payout = plan.payouts.filter(function (p) { return p.kind === step.kind && !p.refusal })[0]
      var row = payout && payout.transfers[step.index]
      if (!row || !sameAddress(row.recipient, step.recipient) || row.amount !== step.amount) {
        throw new Error("The server asked for a transfer that is not in the checked plan")
      }
      if (row.status !== "pending" && row.status !== "failed") throw new Error("The server asked for a transfer the check showed as " + row.status)
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

    // The checked plan's rows still to pay (pending, or reverted before), in
    // the order Disperse pays them.
    function openRows(plan) {
      var rows = []
      plan.payouts.forEach(function (p) {
        if (p.refusal) return
        p.transfers.forEach(function (t) {
          if (t.status === "pending" || t.status === "failed") rows.push({ kind: p.kind, index: t.index, recipient: t.recipient, amount: t.amount })
        })
      })
      return rows
    }

    // Why a check's answer does not hold together, or "": it must be for the
    // account, chain, token and way of paying asked, every row of it paid or
    // ready to send, and its total that of the rows to send.
    function planProblem(result, account, mode) {
      if (!sameAddress(result.account, account)) return "it is for " + result.account + ", not " + account
      if (result.mode !== mode) return "it pays with " + result.mode + ", not " + mode
      if (Number(result.chainId) !== options.chainId) return "it is for chain " + result.chainId + ", not " + options.chainId
      if (options.token && !sameAddress(result.token, options.token)) return "its token is " + result.token + ", not " + options.token
      if (mode === "disperse" && !(result.disperse && sameAddress(result.disperse.address, DISPERSE))) return "it names no Disperse, or another one"
      var due = BigInt(0)
      var odd = ""
      result.payouts.forEach(function (p) {
        if (p.refusal) {
          if (p.transfers.length > 0) odd = "a refused payout lists transfers"
          return
        }
        p.transfers.forEach(function (t) {
          if (t.status === "pending" || t.status === "failed") due += BigInt(t.amount)
          else if (t.status !== "confirmed") odd = "a transfer of it is " + t.status
        })
      })
      if (odd) return odd
      if (due !== BigInt(result.due)) return "its total " + result.due + " is not its rows' " + due
      return ""
    }

    // Rows of the plan not handed to the wallet yet in this run.
    function rowsLeft(plan, handed, batch) {
      if (batch) return handed.disperse ? 0 : openRows(plan).length
      return openRows(plan).filter(function (r) { return !handed[r.kind + ":" + r.index] }).length
    }

    function sameTx(server, built) {
      var tx = server || {}
      if (
        !sameAddress(tx.from, built.from) ||
        !sameAddress(tx.to, built.to) ||
        String(tx.data).toLowerCase() !== built.data.toLowerCase() ||
        tx.value !== "0x0" ||
        Number(tx.chainId) !== Number(built.chainId)
      ) {
        throw new Error("The server's transaction is not the one built here from the checked plan")
      }
    }

    // A Disperse step: the approval of exactly the checked total to Disperse,
    // or the batch of exactly the checked plan's rows still to pay, each asked
    // once in a run. Returns the transaction to hand the wallet, built from the
    // plan.
    function verifyBatchStep(plan, step, handed) {
      var spender = DISPERSE
      if (!plan.disperse || !sameAddress(plan.disperse.address, DISPERSE)) {
        throw new Error("The check names no Disperse, or not the one this page knows")
      }
      var rows = openRows(plan)
      var total = rows.reduce(function (sum, r) { return sum + BigInt(r.amount) }, BigInt(0))
      var chainId = "0x" + plan.chainId.toString(16)
      if (step.state === "approve") {
        if (handed.approve || handed.disperse) throw new Error("The server asked for an approval again in this run")
        if (!sameAddress(step.spender, spender)) throw new Error("The server asked to approve " + step.spender + ", not Disperse (" + spender + ")")
        if (BigInt(step.amount) !== total) throw new Error("The server asked to approve " + step.amount + ", not the checked total " + total)
        var approve = { from: plan.account, to: plan.token, data: approveData(spender, total), value: "0x0", chainId: chainId }
        sameTx(step.tx, approve)
        handed.approve = true
        return approve
      }
      if (step.state !== "disperse") throw new Error("The server asked for a " + step.state + " step, not a Disperse one")
      if (handed.disperse) throw new Error("The server asked for a second batch in this run")
      var listed = step.transfers || []
      var same =
        listed.length === rows.length &&
        listed.every(function (t, i) {
          var r = rows[i]
          return t.kind === r.kind && t.index === r.index && sameAddress(t.recipient, r.recipient) && t.amount === r.amount
        })
      if (!same || BigInt(step.total) !== total) throw new Error("The server's batch is not the checked plan's transfers")
      var data = disperseData(
        plan.token,
        rows.map(function (r) { return r.recipient }),
        rows.map(function (r) { return r.amount })
      )
      var disperse = { from: plan.account, to: spender, data: data, value: "0x0", chainId: chainId }
      sameTx(step.tx, disperse)
      handed.disperse = true
      return disperse
    }

    // `extra`: { mode: "disperse" or "transfers", unrelatedTxs, skipPaidOnChain,
    // paidTxs }: how to pay, and send's --unrelated-tx, --skip-paid-on-chain and
    // --paid-tx for the transfers the check finds on-chain.
    async function check(folder, kinds, extra) {
      if (running) throw new Error("Disbursing right now: stop it first")
      checked = null
      expected = null
      var before = changes
      var account = await walletReady(null)
      expected = { account: account }
      var choice = extra || {}
      var mode = choice.mode === "disperse" ? "disperse" : "transfers"
      var result = await api.check({
        folder: folder,
        kinds: kinds,
        account: account,
        unrelatedTxs: choice.unrelatedTxs || [],
        skipPaidOnChain: !!choice.skipPaidOnChain,
        paidTxs: choice.paidTxs || [],
        mode: mode,
      })
      if (changes !== before) throw new Error("The wallet's account or chain changed during the check: Check again")
      if (result.checkId) {
        var problem = planProblem(result, account, mode)
        if (problem) throw new Error("The server's check does not hold together (" + problem + "): Check again")
        checked = result
      }
      return result
    }

    // Hands the wallet one transaction and follows it to its receipt: true
    // once it is mined as asked, false when the run stops (told by "stopped").
    async function runStep(step, tx) {
      emit("asking", step)
      var hash
      try {
        hash = await wallet.request({ method: "eth_sendTransaction", params: [tx] })
      } catch (error) {
        if (error && error.code === 4001) {
          var rejected = await api.rejected({ requestId: step.requestId })
          emit("stopped", rejected.message)
          return false
        }
        var failed = await api.failed({ requestId: step.requestId, message: (error && error.message) || String(error) })
        emit("stopped", failed.message)
        return false
      }
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        var odd = await api.failed({ requestId: step.requestId, message: "the wallet answered " + hash + " instead of a transaction hash" })
        emit("stopped", odd.message)
        return false
      }
      var sent
      for (var tries = 0; ; tries++) {
        sent = await api.sent({ requestId: step.requestId, hash: hash })
        if (sent.state === "sent") break
        if (tries >= 90) {
          var unseen = await api.failed({ requestId: step.requestId, message: "the RPC never showed " + hash + " (3 minutes)" })
          emit("stopped", unseen.message)
          return false
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
        return false
      }
      emit("confirmed", step, receipt)
      return true
    }

    // Runs the checked plan: through Disperse (the approval if needed, then
    // the batch), or every transfer of it, one at a time.
    async function disburse() {
      if (running) throw new Error("Disbursing already")
      if (!checked || !checked.checkId) throw new Error("Check first")
      var plan = checked
      checked = null // a check is used once
      var batch = plan.mode === "disperse"
      var handed = {} // what was handed to the wallet in this run
      running = true
      stopAfter = false
      emit("running", true)
      try {
        for (;;) {
          var step = batch ? await api.nextBatch({ checkId: plan.checkId }) : await api.next({ checkId: plan.checkId })
          if (step.state === "done") {
            emit("done", step)
            return step
          }
          var tx
          try {
            tx = batch ? verifyBatchStep(plan, step, handed) : verifyStep(plan, step, handed)
            await walletReady(plan.account)
          } catch (error) {
            // the wallet was never asked: nothing was sent
            var note = ""
            try {
              var cleared = await api.rejected({ requestId: step.requestId })
              if (cleared.state !== "cleared") note = ". " + cleared.message
            } catch (again) {
              note = ". " + ((again && again.message) || String(again))
            }
            emit("stopped", error.message + note)
            return null
          }
          if (!(await runStep(step, tx))) return null
          // Stopped (or the wallet's account or chain changed): nothing more is
          // handed out. With nothing left, the server still closes the payouts.
          if (stopAfter && rowsLeft(plan, handed, batch) > 0) {
            emit("stopped", "Stopped after this one: Check again, then Disburse, for the rest")
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
    approveData: approveData,
    disperseData: disperseData,
  }
})
