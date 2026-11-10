/*
 * The disburse page itself: draws what the server and page.js answer, and
 * wires the buttons. Nothing here decides what is paid.
 */
(function () {
  "use strict"
  var P = window.DisbursePage
  var $ = function (id) { return document.getElementById(id) }
  // The run's key, after the "#" of the link the terminal printed: never sent
  // to a server by the browser, never in the page itself.
  var token = decodeURIComponent((window.location.hash || "").slice(1))
  var api = token ? P.createApi({ fetch: window.fetch.bind(window), token: token }) : null
  var wallet = window.ethereum
  var overview = null
  var controller = null
  var busy = false
  var current = null // the transfer with the wallet now
  var KIND_NAMES = { submissions: "Submissions", removals: "Removals", atq: "ATQ" }

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key]
      else if (key === "className") node.className = attrs[key]
      else node.setAttribute(key, attrs[key])
    })
    ;(children || []).forEach(function (child) { if (child) node.append(child) })
    return node
  }
  function link(url, text) {
    if (!url || !/^https:\/\//.test(url)) return document.createTextNode(text)
    return el("a", { href: url, target: "_blank", rel: "noreferrer", text: text })
  }
  function log(text, kind) {
    var item = el("li", { text: text, className: kind || "" })
    $("log").prepend(item)
    return item
  }
  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4) }

  function refresh() {
    var running = !!controller && controller.isRunning()
    $("check").disabled = busy || !controller || running || !selectedFolder() || !selectedKinds().length
    $("disburse").disabled = busy || !controller || !controller.canDisburse()
    $("stop").disabled = !running
    $("folder").disabled = busy || running
    Array.prototype.slice.call(document.querySelectorAll("input[name=kind], .settle-action, #options input")).forEach(function (node) {
      node.disabled = busy || running
    })
  }

  // Another folder, other payouts or other options than the check's: the
  // check no longer says what Disburse would pay.
  function invalidate() {
    if (controller) controller.invalidate()
    $("summary").textContent = ""
    $("payouts").textContent = ""
    $("unsettled").textContent = ""
    refresh()
  }

  function selectedFolder() { return $("folder").value }
  // What send's --unrelated-tx and --skip-paid-on-chain say, for this check.
  function checkOptions() {
    return {
      unrelatedTxs: $("unrelated").value.split(/[\s,]+/).filter(Boolean),
      skipPaidOnChain: $("record-found").checked,
    }
  }
  function selectedKinds() {
    return Array.prototype.slice.call(document.querySelectorAll("input[name=kind]:checked")).map(function (box) { return box.value })
  }

  function renderFolders() {
    var select = $("folder")
    var previous = select.value
    select.textContent = ""
    select.append(el("option", { value: "", text: "Choose the folder to pay…" }))
    overview.folders.forEach(function (folder) {
      var periods = Array.from(new Set(folder.payouts.map(function (p) { return p.period })))
      var total = folder.payouts.reduce(function (sum, p) { return sum + BigInt(p.total) }, BigInt(0))
      var statuses = Array.from(new Set(folder.payouts.map(function (p) { return p.status })))
      var label = folder.id + "  —  " + periods.join(", ") + ", " + P.formatPnk(total.toString()) + " PNK, " + statuses.join(" / ")
      select.append(el("option", { value: folder.id, text: label }))
    })
    select.value = previous && overview.folders.some(function (f) { return f.id === previous }) ? previous : ""
    renderKinds()
  }

  function renderKinds() {
    var box = $("kinds")
    box.textContent = ""
    var folder = overview.folders.filter(function (f) { return f.id === selectedFolder() })[0]
    if (!folder) return
    folder.payouts.forEach(function (p) {
      var input = el("input", { type: "checkbox", name: "kind", value: p.kind })
      input.checked = p.status !== "disbursed" && !p.problem
      input.onchange = invalidate
      var text =
        KIND_NAMES[p.kind] + ": " + p.transfers + " transfer(s), " + P.formatPnk(p.total) + " PNK, " + p.period + ", " +
        p.status + (p.problem ? " (" + p.problem + ")" : "")
      box.append(el("label", { className: "kind" }, [input, document.createTextNode(" " + text)]))
    })
  }

  function rowId(kind, index) { return "row-" + kind + "-" + index }
  function setRow(kind, index, text, url, className) {
    var cell = document.getElementById(rowId(kind, index))
    if (!cell) return
    cell.textContent = ""
    cell.className = className || ""
    cell.append(link(url, text))
  }

  function renderCheck(result) {
    var summary = $("summary")
    summary.textContent = ""
    summary.append(el("h2", { text: "Checked: " + result.folder + " — " + result.payouts.map(function (p) { return KIND_NAMES[p.kind] }).join(", ") }))
    summary.append(
      el("table", { className: "facts" }, [
        el("tr", {}, [el("td", { text: "Paying account" }), el("td", { className: "mono", text: result.account })]),
        el("tr", {}, [el("td", { text: "Network" }), el("td", { text: "chain " + result.chainId + ", PNK " + result.token })]),
        el("tr", {}, [el("td", { text: "Holds" }), el("td", { text: P.formatPnk(result.balance) + " PNK, " + P.formatPnk(result.native, 4) + " for gas" })]),
        el("tr", {}, [el("td", { text: "To send" }), el("td", { text: P.formatPnk(result.due) + " PNK" })]),
      ])
    )
    result.problems.forEach(function (p) { summary.append(el("p", { className: "bad", text: p })) })
    result.notes.forEach(function (n) { summary.append(el("p", { className: "note", text: n })) })

    var payouts = $("payouts")
    payouts.textContent = ""
    result.payouts.forEach(function (p) {
      var section = el("section", { className: "payout" }, [
        el("h2", { text: KIND_NAMES[p.kind] + " " + p.period + ": " + P.formatPnk(p.total) + " PNK" }),
        el("p", { className: "mono small", text: p.file + (p.ledger ? "  ·  ledger " + p.ledger : "") }),
      ])
      if (p.refusal) section.append(el("pre", { className: "bad", text: "Cannot be paid: " + p.refusal }))
      if (p.transfers.length) {
        var table = el("table", { className: "transfers" }, [
          el("tr", {}, [el("th", { text: "#" }), el("th", { text: "Recipient" }), el("th", { text: "PNK" }), el("th", { text: "Status" })]),
        ])
        p.transfers.forEach(function (t) {
          var status = el("td", { id: rowId(p.kind, t.index) })
          status.append(link(t.url, t.status === "confirmed" ? "paid " + short(t.txHash || "") : t.status))
          if (t.status === "confirmed") status.className = "ok"
          table.append(
            el("tr", {}, [
              el("td", { text: String(t.index + 1) }),
              el("td", { className: "mono", text: t.recipient }),
              el("td", { className: "num mono", text: P.formatPnkExact(t.amount) }),
              status,
            ])
          )
        })
        section.append(table)
      }
      if (p.log.length) {
        var details = el("details", {}, [el("summary", { text: "send's checks" }), el("pre", { className: "small", text: p.log.join("\n") })])
        section.append(details)
      }
      payouts.append(section)
    })

    var unsettled = $("unsettled")
    unsettled.textContent = ""
    if (result.unsettled.length) {
      unsettled.append(el("h2", { text: "Handed to a wallet, not settled" }))
      unsettled.append(
        el("p", {
          className: "note",
          text:
            "Before marking one as never sent, make sure the wallet shows no request or transaction for it: reject it there if it does. " +
            "A request approved later would pay it a second time.",
        })
      )
      result.unsettled.forEach(function (u) {
        var actions = u.actions || []
        if (!actions.length) {
          unsettled.append(el("div", { className: "unsettled" }, [el("p", { className: "bad", text: u.why })]))
          return
        }
        var input = el("input", { type: "text", placeholder: "0x… its transaction hash, from the wallet's activity", className: "mono hash settle-action" })
        var record = el("button", { text: "Record this hash", className: "settle-action" })
        var never = el("button", { text: "It was never sent", className: "settle-action" })
        record.onclick = function () {
          run(async function () {
            var r = await controller.recordHash({ recordId: u.recordId, index: u.index, hash: input.value.trim() })
            invalidate()
            log(r.message, "ok")
          })
        }
        never.onclick = function () {
          if (!window.confirm("The wallet shows no request or transaction for " + P.formatPnk(u.amount) + " PNK to " + u.recipient + "?")) return
          run(async function () {
            var r = await controller.forget({ recordId: u.recordId, index: u.index })
            invalidate()
            log(r.message, "ok")
          })
        }
        unsettled.append(
          el("div", { className: "unsettled" }, [
            el("p", { className: "bad", text: u.why }),
            actions.indexOf("hash") >= 0 ? input : null,
            actions.indexOf("hash") >= 0 ? record : null,
            actions.indexOf("forget") >= 0 ? never : null,
          ])
        )
      })
    }
  }

  async function run(action) {
    busy = true
    refresh()
    try {
      await action()
    } catch (error) {
      log((error && error.message) || String(error), "bad")
    } finally {
      busy = false
      refresh()
    }
  }

  function start() {
    controller = P.createController({
      wallet: wallet,
      api: api,
      chainId: overview.chainId,
      payer: overview.payer,
      events: {
        running: function () { refresh() },
        voided: function (event) {
          log("The wallet's " + (event === "chainChanged" ? "chain" : "account") + " changed: Check again", "bad")
          refresh()
        },
        asking: function (step) {
          current = step
          refresh()
          setRow(step.kind, step.index, "confirm in the wallet…", null, "busy")
          log("Asking the wallet: " + P.formatPnk(step.amount) + " PNK to " + step.recipient + " (" + KIND_NAMES[step.kind] + " #" + (step.index + 1) + ")")
        },
        unverified: function (step, hash) { setRow(step.kind, step.index, "waiting for the RPC to see " + short(hash), null, "busy") },
        sent: function (step, sent) { setRow(step.kind, step.index, "sent " + short(sent.hash) + ", waiting for a block", sent.url, "busy") },
        waiting: function (step, receipt, minutes) {
          if (minutes < 3) return
          setRow(
            step.kind,
            step.index,
            "sent " + short(receipt.hash) + ", not mined after " + minutes + " min: speed it up in the wallet if it shows it pending",
            null,
            "busy"
          )
        },
        confirmed: function (step, receipt) {
          current = null
          setRow(step.kind, step.index, "paid " + short(receipt.hash) + " (block " + receipt.block + ")", receipt.url, "ok")
          log("Paid " + P.formatPnk(step.amount) + " PNK to " + step.recipient + (receipt.note ? ": " + receipt.note : ""), "ok")
        },
        stopped: function (message) {
          if (current) setRow(current.kind, current.index, "stopped: Check again (see the log)", null, "bad")
          current = null
          log(message, "bad")
          refresh()
        },
        done: function (step) {
          log("Done: " + step.payouts.map(function (p) { return KIND_NAMES[p.kind] + " " + p.status + " (" + p.ledger + ")" }).join("; ") + ". Commit disbursements/.", "ok")
        },
      },
    })
    $("check").onclick = function () {
      run(async function () {
        log("Checking " + selectedFolder() + ": " + selectedKinds().join(", ") + "…")
        var result = await controller.check(selectedFolder(), selectedKinds(), checkOptions())
        renderCheck(result)
        log(result.checkId ? "Checked: Disburse sends " + P.formatPnk(result.due) + " PNK, one transfer at a time." : "Nothing can be sent: see why above.", result.checkId ? "ok" : "bad")
      })
    }
    $("disburse").onclick = function () {
      run(async function () {
        log("Disbursing: confirm each transfer in the wallet (and on the device)")
        await controller.disburse()
        overview = await api.overview()
        renderFolders()
      })
    }
    $("stop").onclick = function () {
      controller.stop()
      log("Stopping after the transfer with the wallet now…")
    }
    $("folder").onchange = function () {
      renderKinds()
      invalidate()
    }
    $("unrelated").oninput = invalidate
    $("record-found").onchange = invalidate
    refresh()
  }

  if (!token) {
    log("This page needs the run's key: open the whole link the terminal printed, the part after # included", "bad")
    return
  }
  if (!wallet) log("There is no browser wallet on this page: open it in the browser that has the wallet (Rabby, MetaMask…)", "bad")
  api
    .overview()
    .then(function (o) {
      overview = o
      $("payer").textContent = o.payer ? "Paying account: " + o.payer + " (SEND_FROM)" : "Paying account: whichever the wallet has selected (SEND_FROM pins one)"
      renderFolders()
      if (wallet) start()
      if (!o.folders.length) log("No folder of files/ has a generate or removals manifest to pay", "bad")
    })
    .catch(function (error) { log((error && error.message) || String(error), "bad") })
  window.addEventListener("beforeunload", function (event) {
    if (controller && controller.isRunning()) {
      event.preventDefault()
      event.returnValue = ""
    }
  })
})()
