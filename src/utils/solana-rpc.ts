import { httpFetch } from "./http"
import { sleep } from "./runtime-helpers"

// Solana JSON-RPC over one or more URLs (SOLANA_RPC_URLS, comma-separated).
// Every URL gets its own pacing and in-flight cap, and each call goes to
// whichever URL has capacity first, so adding a Helius or Alchemy URL (free
// keys) speeds everything up without other changes.
// URLs can embed API keys: only masked labels are logged, and every error
// text goes through redactSecrets.

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly httpStatus?: number,
    readonly kind?: "too-large" | "timeout",
    // Index of the URL that produced it, when one did.
    readonly endpoint?: number
  ) {
    super(message)
  }
}

interface Endpoint {
  url: string
  label: string
  isPublic: boolean
  intervalMs: number // current spacing between calls; adapts to 429s
  minIntervalMs: number // configured spacing, the fastest allowed
  lastBackoffAt: number
  lastAdjustAt: number // last backoff or recovery step
  maxInFlight: number
  methodIntervalMs: { [method: string]: number }
  nextAt: number
  methodNextAt: { [method: string]: number }
  pausedUntil: number
  inFlight: number
  disabled: string | null
  disabledStatus?: number
  refused: { [method: string]: number } // HTTP status of a refusal that only concerns this method
  consecutiveFailures: number
  calls: number
  rateLimited: number
  errors: number
}

export interface CallOptions {
  timeoutMs?: number
  maxBytes?: number
  // Throw a `timeout` error instead of retrying (callers with a fallback).
  failFastOnTimeout?: boolean
  // Transient failures tolerated before giving up (default 8).
  maxAttempts?: number
  // Send the call to this URL only (an index from endpointOrder or onAnswer).
  only?: number
  // Send the call to any other URL than these, while one is still enabled.
  avoid?: number[]
  // Told which URL answered.
  onAnswer?: (endpoint: number) => void
}

export interface EndpointStats {
  label: string
  calls: number
  rateLimited: number
  errors: number
  disabled: string | null
  rps: number // current pacing
}

// JSON-RPC errors worth retrying: long-term storage hiccups (-32019), node
// behind/unhealthy (-32005), block status not available yet (-32014), internal
// errors (-32603). Not -32004 "block not available": callers treat it as an
// empty slot and move on.
const RETRYABLE_RPC_CODES = [-32019, -32005, -32014, -32603]
const MAX_ATTEMPTS = 8

// A 429 slows that URL down by half again; answers without one bring it back
// toward its configured rate. A provider whose real limit is below its
// defaults then settles just under it instead of being hit at full rate and
// parked for 10 s after every burst (Alchemy Free sends no Retry-After). It
// does not raise a provider's ceiling: on 2026-10-06, getSignaturesForAddress
// sustained ~0.5 calls/s on Alchemy Free and ~5-6 on Helius Free either way.
const BACKOFF_FACTOR = 1.5
const RECOVER_FACTOR = 0.9
// Recovery is per time, not per answer: a URL slowed to 0.1 call/s would
// otherwise need hours of answers to get back up.
const RECOVER_EVERY_MS = 10000
const MAX_INTERVAL_MS = 10000

const PUBLIC_RPC_HOST = /(^|\.)api\.mainnet(-beta)?\.solana\.com$/

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

export const maskRpcUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname
      .split("/")
      .map((part) => (part.length >= 16 ? "***" : part))
      .join("/")
    return `${parsed.host}${path === "/" ? "" : path}${parsed.search ? "?***" : ""}`
  } catch {
    return "<invalid url>"
  }
}

// Any URL inside a text, masked like the labels.
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

// The secret parts of a URL (query values, long path segments, password) in
// every form a message can carry them: raw, percent-encoded and decoded.
const secretsOf = (raw: string): string[] => {
  const found: string[] = []
  try {
    const url = new URL(raw.trim())
    url.searchParams.forEach((value) => {
      if (value.length >= 8) found.push(value)
    })
    for (const part of url.pathname.split("/")) if (part.length >= 16) found.push(part)
    if (url.password) found.push(url.password)
  } catch {
    // unparseable: only the URL_TOKEN pass applies
  }
  const variants = new Set<string>()
  for (const secret of found) {
    variants.add(secret)
    variants.add(encodeURIComponent(secret))
    try {
      variants.add(decodeURIComponent(secret))
    } catch {
      // keep the other forms
    }
  }
  return Array.from(variants).sort((a, b) => b.length - a.length)
}

// node-fetch error messages embed the full request URL, API key included, in
// forms that need not match the configured string (legacy escaping, redirect
// targets), and servers can echo it: mask every URL and every known secret.
export const redactSecrets = (text: string, urls: string[] = []): string => {
  let out = String(text).replace(URL_TOKEN, (match) => maskRpcUrl(match))
  for (const url of urls) {
    for (const secret of secretsOf(url)) out = out.split(secret).join("***")
  }
  return out
}

// Conservative defaults by provider. Public mainnet: the response headers
// allow 10 calls per 10 s per method (6 for getBlock) per IP. Helius free:
// 10 req/s (getProgramAccounts 5/s). Alchemy free: 300-500 CU/s at 40 CU per
// getSignaturesForAddress.
const defaultsFor = (url: string): { rps: number; inFlight: number; methodRps: { [m: string]: number } } => {
  const host = hostOf(url)
  if (PUBLIC_RPC_HOST.test(host)) {
    return { rps: 0.75, inFlight: 5, methodRps: { getBlock: 0.5 } }
  }
  if (/helius-rpc\.com$/.test(host)) return { rps: 9, inFlight: 30, methodRps: { getProgramAccounts: 4 } }
  if (/alchemy\.com$/.test(host)) return { rps: 7, inFlight: 30, methodRps: {} }
  return { rps: 5, inFlight: 10, methodRps: {} }
}

const csv = (raw?: string): string[] =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim())

export class SolanaRpcPool {
  private readonly endpoints: Endpoint[]
  private readonly urls: string[]
  private id = 0

  constructor(configs: { url: string; rps?: number; inFlight?: number }[]) {
    if (configs.length === 0) throw new Error("[solana-rpc] no RPC URL configured")
    this.urls = configs.map((c) => c.url)
    this.endpoints = configs.map(({ url, rps, inFlight }) => {
      const defaults = defaultsFor(url)
      const methodIntervalMs: { [m: string]: number } = {}
      for (const method of Object.keys(defaults.methodRps)) {
        methodIntervalMs[method] = 1000 / defaults.methodRps[method]
      }
      const effectiveRps = rps && rps > 0 ? rps : defaults.rps
      return {
        url,
        label: maskRpcUrl(url),
        isPublic: PUBLIC_RPC_HOST.test(hostOf(url)),
        intervalMs: 1000 / effectiveRps,
        minIntervalMs: 1000 / effectiveRps,
        lastBackoffAt: 0,
        lastAdjustAt: 0,
        maxInFlight: inFlight && inFlight > 0 ? inFlight : defaults.inFlight,
        methodIntervalMs,
        nextAt: 0,
        methodNextAt: {},
        pausedUntil: 0,
        inFlight: 0,
        disabled: null,
        refused: {},
        consecutiveFailures: 0,
        calls: 0,
        rateLimited: 0,
        errors: 0,
      }
    })
  }

  // Concurrent calls that can be useful at once (sum of in-flight caps).
  capacity(): number {
    return this.endpoints.reduce((sum, ep) => sum + ep.maxInFlight, 0)
  }

  labels(): string[] {
    return this.endpoints.map((ep) => ep.label)
  }

  label(index: number): string {
    return this.endpoints[index] ? this.endpoints[index].label : `URL #${index}`
  }

  // URL indexes, the public endpoint first when asked.
  endpointOrder(publicFirst = false): number[] {
    const order = this.endpoints.map((_, i) => i)
    if (!publicFirst) return order
    return order.filter((i) => this.endpoints[i].isPublic).concat(order.filter((i) => !this.endpoints[i].isPublic))
  }

  stats(): EndpointStats[] {
    return this.endpoints.map((ep) => ({
      label: ep.label,
      calls: ep.calls,
      rateLimited: ep.rateLimited,
      errors: ep.errors,
      disabled: ep.disabled,
      rps: Math.round(10000 / ep.intervalMs) / 10,
    }))
  }

  // A URL that refuses its key (HTTP 401/402/403, e.g. an Alchemy key limited
  // to some web origins) would otherwise be dropped with one warning, leaving a
  // much slower run: try each URL once, up front.
  async assertKeysAccepted(): Promise<void> {
    const rejected: string[] = []
    for (let i = 0; i < this.endpoints.length; i++) {
      try {
        await this.call<number>("getSlot", [{ commitment: "finalized" }], { only: i, maxAttempts: 2 })
      } catch (err) {
        const status = err instanceof SolanaRpcError ? err.httpStatus : undefined
        if (status === 401 || status === 402 || status === 403) {
          rejected.push(`${this.endpoints[i].label} (HTTP ${status})`)
        } else {
          console.warn(`[solana-rpc] ${this.endpoints[i].label} did not answer at start, continuing: ${(err as Error).message}`)
        }
      }
    }
    if (rejected.length > 0) {
      throw new Error(
        `[solana-rpc] RPC URL(s) refused the request: ${rejected.join(", ")}. ` +
          "Check the key in SOLANA_RPC_URLS and any origin or IP allowlist set on it, or remove the URL."
      )
    }
  }

  async call<T>(method: string, params: unknown[], options: CallOptions = {}): Promise<T> {
    const maxAttempts = options.maxAttempts || MAX_ATTEMPTS
    let attempts = 0
    let rateLimitedWaits = 0
    let lastError: Error | null = null
    for (;;) {
      const ep = await this.acquire(method, options)
      const index = this.endpoints.indexOf(ep)
      const fail = (text: string, code?: number, httpStatus?: number, kind?: "too-large" | "timeout") =>
        new SolanaRpcError(redactSecrets(text, this.urls), code, httpStatus, kind, index)
      let retryDelayMs = 0
      try {
        const res = await httpFetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          timeout: options.timeoutMs || 90000,
          size: options.maxBytes || 0,
        })
        ep.calls++
        if (res.status === 429) {
          await res.text().catch(() => "")
          this.pause(ep, Number(res.headers.get("retry-after")))
          if (++rateLimitedWaits > 300) throw fail(`[solana-rpc] ${method}: rate limited too many times`, 429, 429)
          continue
        }
        if (res.status === 401 || res.status === 402) {
          const text = (await res.text().catch(() => "")).slice(0, 200)
          ep.disabled = `HTTP ${res.status}`
          ep.disabledStatus = res.status
          console.warn(redactSecrets(`[solana-rpc] Disabling ${ep.label}: HTTP ${res.status} ${text}`, this.urls))
          continue
        }
        if (res.status === 403 || res.status === 410) {
          const text = (await res.text().catch(() => "")).slice(0, 200)
          // The public RPC refuses some getProgramAccounts filters and not
          // others: a holder scan (pinned to one URL) moves on to the next URL
          // without the refusal keeping that URL from the next scan.
          if (method === "getProgramAccounts" && options.only !== undefined) {
            throw fail(`[solana-rpc] ${method}: HTTP ${res.status} ${text}`, undefined, res.status)
          }
          this.refuse(ep, method, res.status, text)
          continue
        }
        if (res.status === 413) {
          throw fail(`[solana-rpc] ${method}: response too large (HTTP 413)`, undefined, 413, "too-large")
        }
        const text = await res.text()
        if (res.status >= 500) {
          lastError = fail(`[solana-rpc] ${method}: HTTP ${res.status} ${text.slice(0, 200)}`, undefined, res.status)
          retryDelayMs = this.backoff(++attempts)
        } else if (!res.ok) {
          throw fail(`[solana-rpc] ${method}: HTTP ${res.status} ${text.slice(0, 300)}`, undefined, res.status)
        } else {
          let body: { result?: T; error?: { code?: number; message?: string } }
          try {
            body = JSON.parse(text)
          } catch {
            body = { error: { code: -32700, message: `unparseable response: ${text.slice(0, 120)}` } }
          }
          if (body.error) {
            const code = Number(body.error.code)
            const msg = `[solana-rpc] ${method}: ${body.error.message || "error"} (code ${code})`
            if (code === 429 || /too many requests/i.test(String(body.error.message))) {
              this.pause(ep, NaN)
              if (++rateLimitedWaits > 300) throw fail(msg, code)
              continue
            }
            if (code === -32016 || code === -32700 || RETRYABLE_RPC_CODES.includes(code)) {
              lastError = fail(msg, code)
              retryDelayMs = code === -32016 ? 2000 : this.backoff(++attempts)
              if (code === -32016) attempts++
            } else {
              throw fail(msg, code)
            }
          } else {
            ep.consecutiveFailures = 0
            this.recover(ep)
            if (options.onAnswer) options.onAnswer(index)
            return body.result as T
          }
        }
      } catch (err) {
        if (err instanceof SolanaRpcError) throw err
        const e = err as Error & { type?: string }
        if (e.type === "max-size") {
          throw fail(`[solana-rpc] ${method}: response larger than ${options.maxBytes} bytes`, undefined, undefined, "too-large")
        }
        if ((e.type === "request-timeout" || e.type === "body-timeout") && options.failFastOnTimeout) {
          throw fail(`[solana-rpc] ${method}: timed out`, undefined, undefined, "timeout")
        }
        lastError = fail(`[solana-rpc] ${method} via ${ep.label}: ${e.message}`)
        retryDelayMs = this.backoff(++attempts)
      } finally {
        ep.inFlight--
      }
      ep.errors++
      ep.consecutiveFailures++
      // A URL that keeps failing sits out for a minute so the others take over.
      if (ep.consecutiveFailures >= 10) ep.pausedUntil = Date.now() + 60000
      if (attempts >= maxAttempts) throw lastError || fail(`[solana-rpc] ${method}: failed`)
      await sleep(retryDelayMs)
    }
  }

  // 403 and 410 can concern one method only: Helius answers 403 for what the
  // plan does not include, Triton 410 for disabled calls. They can also concern the key (Alchemy
  // answers 403 once its monthly capacity is used up). The URL stops serving
  // that method, and stops altogether once a second method is refused.
  private refuse(ep: Endpoint, method: string, status: number, text: string): void {
    if (ep.disabled || ep.refused[method]) return // a concurrent call already handled it
    ep.refused[method] = status
    const methods = Object.keys(ep.refused)
    if (methods.length >= 2) {
      ep.disabled = `HTTP ${status} on ${methods.join(", ")}`
      ep.disabledStatus = status
      console.warn(redactSecrets(`[solana-rpc] Disabling ${ep.label}: HTTP ${status} on ${methods.join(" and ")} ${text}`, this.urls))
    } else {
      console.warn(
        redactSecrets(`[solana-rpc] ${ep.label} refuses ${method} (HTTP ${status} ${text}); other URLs serve it`, this.urls)
      )
    }
  }

  private pause(ep: Endpoint, retryAfterSecs: number): void {
    ep.rateLimited++
    const now = Date.now()
    // Calls already in flight answer 429 together: slow down once per burst.
    if (now - ep.lastBackoffAt > 1000) {
      ep.intervalMs = Math.min(MAX_INTERVAL_MS, ep.intervalMs * BACKOFF_FACTOR)
      ep.lastBackoffAt = now
    }
    ep.lastAdjustAt = now
    // The public RPC limits per 10 s window and counts rejected calls too, so
    // it sits out the window; keyed providers limit per second.
    const fallbackMs = ep.isPublic ? 10000 : 1000
    const waitMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0 ? retryAfterSecs * 1000 : fallbackMs
    ep.pausedUntil = Math.max(ep.pausedUntil, now + waitMs + Math.floor(Math.random() * 500))
  }

  // After RECOVER_EVERY_MS without a 429, edge back toward the configured rate.
  private recover(ep: Endpoint): void {
    if (ep.intervalMs <= ep.minIntervalMs) return
    const now = Date.now()
    if (now - ep.lastAdjustAt < RECOVER_EVERY_MS) return
    ep.lastAdjustAt = now
    ep.intervalMs = Math.max(ep.minIntervalMs, ep.intervalMs * RECOVER_FACTOR)
  }

  private backoff(attempt: number): number {
    return Math.min(60000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)
  }

  private async acquire(method: string, options: CallOptions): Promise<Endpoint> {
    const avoid = options.avoid || []
    for (;;) {
      const now = Date.now()
      if (options.only !== undefined) {
        const pinned = this.endpoints[options.only]
        if (!pinned) throw new SolanaRpcError(`[solana-rpc] no RPC URL #${options.only}`)
        if (pinned.disabled || pinned.refused[method]) {
          throw new SolanaRpcError(
            pinned.disabled
              ? `[solana-rpc] ${pinned.label} is disabled (${pinned.disabled})`
              : `[solana-rpc] ${pinned.label} refuses ${method} (HTTP ${pinned.refused[method]})`,
            undefined,
            pinned.disabled ? pinned.disabledStatus : pinned.refused[method],
            undefined,
            options.only
          )
        }
      }
      const serves = (ep: Endpoint) => !ep.disabled && !ep.refused[method]
      // `avoid` only applies while some other URL still serves the method.
      const skipAvoided = this.endpoints.some((ep, i) => serves(ep) && avoid.indexOf(i) < 0)
      let best: Endpoint | null = null
      let bestAt = Infinity
      let enabled = 0
      for (let i = 0; i < this.endpoints.length; i++) {
        const ep = this.endpoints[i]
        if (!serves(ep)) continue
        enabled++
        if (options.only !== undefined && i !== options.only) continue
        if (skipAvoided && avoid.indexOf(i) >= 0) continue
        if (ep.inFlight >= ep.maxInFlight) continue
        const at = Math.max(ep.nextAt, ep.pausedUntil, ep.methodNextAt[method] || 0)
        if (at < bestAt) {
          best = ep
          bestAt = at
        }
      }
      if (enabled === 0) {
        const why = (e: Endpoint) => e.disabled || `refuses ${method} (HTTP ${e.refused[method]})`
        throw new SolanaRpcError(
          `[solana-rpc] no RPC URL serves ${method} (${this.endpoints.map((e) => `${e.label}: ${why(e)}`).join(", ")})`
        )
      }
      if (!best) {
        await sleep(50)
        continue
      }
      if (bestAt > now) {
        await sleep(Math.min(bestAt - now, 250))
        continue
      }
      best.nextAt = now + best.intervalMs
      const methodInterval = best.methodIntervalMs[method]
      if (methodInterval) best.methodNextAt[method] = now + methodInterval
      best.inFlight++
      return best
    }
  }
}

// A comma-separated setting without its trailing empty entries.
const list = (raw?: string): string[] => {
  const items = csv(raw)
  while (items.length > 0 && !items[items.length - 1]) items.pop()
  return items
}

// The URLs of SOLANA_RPC_URLS (`fallbackUrl` when there are none).
export const solanaRpcUrls = (fallbackUrl?: string): string[] => {
  const urls = list(process.env.SOLANA_RPC_URLS).filter(Boolean)
  return urls.length === 0 && fallbackUrl ? [fallbackUrl] : urls
}

// SOLANA_RPC_URLS (or `fallbackUrl`) with their SOLANA_RPC_MAX_RPS /
// SOLANA_RPC_MAX_INFLIGHT overrides, matched by position (an empty value or 0
// keeps the provider's default). A typo throws instead of silently falling back
// to the default, and so do an empty entry between URLs and more values than
// URLs while overrides are set: either leaves no way to tell which URL each
// value was meant for.
export const solanaRpcConfigs = (fallbackUrl?: string): { url: string; rps?: number; inFlight?: number }[] => {
  let urls = list(process.env.SOLANA_RPC_URLS)
  if (urls.length === 0 && fallbackUrl) urls = [fallbackUrl]
  const rps = list(process.env.SOLANA_RPC_MAX_RPS)
  const inFlight = list(process.env.SOLANA_RPC_MAX_INFLIGHT)
  if (rps.length > 0 || inFlight.length > 0) {
    if (urls.some((url) => !url)) {
      throw new Error(
        "[solana-rpc] SOLANA_RPC_URLS has an empty entry, so SOLANA_RPC_MAX_RPS / SOLANA_RPC_MAX_INFLIGHT " +
          "cannot be matched to the URLs: remove the extra comma"
      )
    }
    if (rps.length > urls.length || inFlight.length > urls.length) {
      throw new Error(
        `[solana-rpc] SOLANA_RPC_MAX_RPS / SOLANA_RPC_MAX_INFLIGHT list more values than the ${urls.length} RPC URL(s): ` +
          "keep one value per URL, in the order of SOLANA_RPC_URLS"
      )
    }
  }
  const value = (name: string, raw: string | undefined, integer: boolean): number | undefined => {
    if (!raw) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      throw new Error(`[solana-rpc] Invalid ${name} entry "${raw}": expected a ${integer ? "whole " : ""}number >= 0`)
    }
    return n > 0 ? n : undefined
  }
  return urls
    .map((url, i) => ({
      url,
      rps: value("SOLANA_RPC_MAX_RPS", rps[i], false),
      inFlight: value("SOLANA_RPC_MAX_INFLIGHT", inFlight[i], true),
    }))
    .filter((config) => config.url)
}

export const createSolanaRpcPool = (fallbackUrl: string): SolanaRpcPool => new SolanaRpcPool(solanaRpcConfigs(fallbackUrl))
