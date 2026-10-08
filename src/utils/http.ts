import fetch from "node-fetch"

// node-fetch v2 request options, including its `timeout` and `size`
// extensions, which the installed typings do not expose under TypeScript 3.9.
export interface HttpInit {
  method?: string
  headers?: { [header: string]: string }
  body?: string
  timeout?: number
  size?: number
}

export const httpFetch = (url: string, init: HttpInit = {}): ReturnType<typeof fetch> =>
  fetch(url, init as unknown as Parameters<typeof fetch>[1])
