export * from "./client.js"
export * from "./server.js"

import { createQueryAIClient } from "./client.js"
import { createQueryAIServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createQueryAI(options?: ServerOptions) {
  const server = await createQueryAIServer({
    ...options,
  })

  const client = createQueryAIClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
