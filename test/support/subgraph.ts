import { MockServer, startMockServer } from "./http"
import { REGISTRY } from "./fixtures"

// The Curate (GTCR) indexer behind XDAI_GTCR_SUBGRAPH_URL: answers the LItem
// queries the pipeline sends (Hasura where-clauses on registry, status, time
// window and key0, with limit/offset paging), and can fail like a real one.

export interface MockRequest {
  requester: string
  requestType: "RegistrationRequested" | "ClearingRequested"
  resolutionTime: number
  submissionTime?: number
}

export interface MockItem {
  id: string
  itemID: string
  registryAddress: string
  status: "Registered" | "ClearingRequested" | "Absent" | "RegistrationRequested"
  latestRequestResolutionTime: number
  latestRequestSubmissionTime?: number
  numberOfRequests: number
  requests: MockRequest[]
  props: { value: string }[]
  key0: string
  key1: string
  key2: string
  key3: string
}

let counter = 0

// An item of `registry` (a key of REGISTRY or an address).
export const subgraphItem = (registry: keyof typeof REGISTRY | string, overrides: Partial<MockItem> = {}): MockItem => {
  const address = (REGISTRY as { [k: string]: string })[registry] || registry
  counter++
  const itemID = overrides.itemID || `0x${counter.toString(16).padStart(64, "0")}`
  const requests = overrides.requests || [
    { requester: "0x00000000000000000000000000000000000a11ce", requestType: "RegistrationRequested" as const, resolutionTime: 1788000000, submissionTime: 1787900000 },
  ]
  return {
    id: `${itemID}@${address}`,
    itemID,
    registryAddress: address,
    status: "Registered",
    latestRequestResolutionTime: requests.length ? Math.max(...requests.map((r) => r.resolutionTime)) : 0,
    numberOfRequests: requests.length,
    requests,
    props: [],
    key0: `eip155:1:0x${counter.toString(16).padStart(40, "0")}`,
    key1: "Contract name",
    key2: "",
    key3: "",
    ...overrides,
  }
}

interface Where {
  registry?: string
  statuses?: string[]
  gte?: number
  lt?: number
  key0s?: string[]
  limit: number
  offset: number
}

const parseWhere = (query: string): Where => {
  const registry = /registryAddress: \{_eq:"([^"]+)"\}/.exec(query) || /registry_id: \{ _eq: "([^"]+)"\}/.exec(query)
  const statusIn = /status: \{_in: (\[[^\]]*\])\}/.exec(query)
  const statusEq = /status: \{_eq: "([^"]+)"\}/.exec(query)
  const window = /latestRequestResolutionTime: \{_gte: (\d+), _lt: (\d+)\}/.exec(query)
  const key0 = /key0: \{_in: (\[[^\]]*\])\}/.exec(query)
  const limit = /limit: (\d+)/.exec(query)
  const offset = /offset: (\d+)/.exec(query)
  return {
    registry: registry ? registry[1] : undefined,
    statuses: statusIn ? JSON.parse(statusIn[1]) : statusEq ? [statusEq[1]] : undefined,
    gte: window ? Number(window[1]) : undefined,
    lt: window ? Number(window[2]) : undefined,
    key0s: key0 ? JSON.parse(key0[1]) : undefined,
    limit: limit ? Number(limit[1]) : 100,
    offset: offset ? Number(offset[1]) : 0,
  }
}

export class MockSubgraph {
  items: MockItem[] = []
  queries: Where[] = []
  // Fail every request with this HTTP status, or with GraphQL errors, from the n-th on.
  fault?: { status?: number; graphqlErrors?: boolean; fromRequest?: number }
  private server!: MockServer
  private requestCount = 0

  get url(): string {
    return `${this.server.url}/v1/graphql`
  }

  add(...items: MockItem[]): this {
    this.items.push(...items)
    return this
  }

  async start(): Promise<this> {
    this.server = await startMockServer((req) => {
      this.requestCount++
      const query: string = (req.json && req.json.query) || ""
      if (this.fault && this.requestCount >= (this.fault.fromRequest || 1)) {
        if (this.fault.status) return { status: this.fault.status, raw: "upstream error" }
        if (this.fault.graphqlErrors) return { body: { errors: [{ message: "field 'LItem' not found" }] } }
      }
      const where = parseWhere(query)
      this.queries.push(where)
      const matches = this.items
        .filter((item) => !where.registry || item.registryAddress === where.registry)
        .filter((item) => !where.statuses || where.statuses.includes(item.status))
        .filter((item) => where.gte === undefined || item.latestRequestResolutionTime >= where.gte)
        .filter((item) => where.lt === undefined || item.latestRequestResolutionTime < (where.lt as number))
        .filter((item) => !where.key0s || where.key0s.includes(item.key0))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(where.offset, where.offset + where.limit)
        // the indexer returns numbers as strings in places; the code must cope
        .map((item) => ({ ...item, latestRequestResolutionTime: String(item.latestRequestResolutionTime) }))
      return { body: { data: { litems: matches } } }
    })
    return this
  }

  stop(): Promise<void> {
    return this.server.close()
  }
}
