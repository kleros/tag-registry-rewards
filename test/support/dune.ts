import { MockServer, MockReply, startMockServer } from "./http"

// The Dune API behind DUNE_BASE_URL: /sql/execute, then /execution/<id>/status
// polls, then /execution/<id>/results. Answers the pipeline's three queries
// (EVM tx counts, Solana tx counts, Solana holders) from its tables.
export class MockDune {
  evmCounts: { [chainId: string]: { [addressLower: string]: number } } = {}
  solanaCounts: { [address: string]: number } = {}
  solanaHolders: { [mint: string]: number } = {}
  sqls: string[] = []
  apiKeys: string[] = []
  // States answered to each status poll before "completed".
  pendingPolls = 1
  failState?: string // e.g. "QUERY_STATE_FAILED"
  // The next N requests answer HTTP 429.
  rateLimited = 0
  private server!: MockServer
  private polls: { [id: string]: number } = {}

  get url(): string {
    return `${this.server.url}/api/v1`
  }

  async start(): Promise<this> {
    this.server = await startMockServer((req) => this.handle(req.method, req.path, req.json, String(req.headers["x-dune-api-key"] || "")))
    return this
  }

  stop(): Promise<void> {
    return this.server.close()
  }

  private handle(method: string, path: string, body: any, key: string): MockReply {
    this.apiKeys.push(key)
    if (this.rateLimited > 0) {
      this.rateLimited--
      return { status: 429, body: { error: "rate limited" } }
    }
    if (method === "POST" && path === "/api/v1/sql/execute") {
      this.sqls.push(body.sql)
      const id = `ex-${this.sqls.length}`
      this.polls[id] = 0
      return { body: { execution_id: id, state: "QUERY_STATE_PENDING" } }
    }
    const status = /^\/api\/v1\/execution\/([^/]+)\/status$/.exec(path)
    if (status) {
      const n = ++this.polls[status[1]]
      if (this.failState) return { body: { state: this.failState } }
      return { body: { state: n > this.pendingPolls ? "QUERY_STATE_COMPLETED" : "QUERY_STATE_EXECUTING" } }
    }
    const results = /^\/api\/v1\/execution\/ex-(\d+)\/results$/.exec(path)
    if (results) return { body: { result: { rows: this.rowsFor(this.sqls[Number(results[1]) - 1]) } } }
    return { status: 404, body: { error: `no route ${method} ${path}` } }
  }

  private rowsFor(sql: string): unknown[] {
    if (sql.includes("solana_utils.token_accounts")) {
      return quoted(sql)
        .filter((mint) => this.solanaHolders[mint] !== undefined)
        .map((mint) => ({ token_mint_address: mint, total_holders: this.solanaHolders[mint] }))
    }
    if (sql.includes("solana.account_activity")) {
      return quoted(sql)
        .filter((address) => this.solanaCounts[address] !== undefined)
        .map((address) => ({ address, total_txns: this.solanaCounts[address] }))
    }
    // EVM: one UNION ALL part per chain, "... AS tx_count, <chainId> AS chain ... IN (from_hex(...), ...)"
    const rows: unknown[] = []
    for (const part of sql.split("UNION ALL")) {
      const chain = /COUNT\(\*\) AS tx_count, (\d+) AS chain/.exec(part)
      if (!chain) continue
      const counts = this.evmCounts[chain[1]] || {}
      for (const address of all(part, /from_hex\(replace\('(0x[0-9a-f]+)', '0x', ''\)\)/g)) {
        if (counts[address] !== undefined) rows.push({ address, tx_count: counts[address], chain: chain[1] })
      }
    }
    return rows
  }
}

// The first capture group of every match (String#matchAll is not in ES2019).
const all = (text: string, pattern: RegExp): string[] => {
  const out: string[] = []
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) out.push(m[1])
  return out
}

const quoted = (sql: string): string[] => {
  const list = /IN \(([^)]*)\)/.exec(sql)
  return list ? all(list[1], /'([^']+)'/g) : []
}
