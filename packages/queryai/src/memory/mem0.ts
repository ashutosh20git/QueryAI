import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const DEFAULT_BASE_URL = "https://api.mem0.ai"

export class Mem0Error extends Schema.TaggedErrorClass<Mem0Error>()("Mem0Error", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * mem0 returns a wide row - scores, categories, expiry, graph fields. Decode only
 * what we consume; unknown keys are dropped, so the platform can grow its payload
 * without breaking us.
 */
export const Item = Schema.Struct({
  id: Schema.String,
  memory: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  score: Schema.optional(Schema.NullOr(Schema.Number)),
})
export type Item = Schema.Schema.Type<typeof Item>

const SearchResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(Item)),
})

const ListResponse = Schema.Struct({
  count: Schema.optional(Schema.Number),
  results: Schema.optional(Schema.Array(Item)),
})

const AddResult = Schema.Struct({
  id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  data: Schema.optional(Schema.NullOr(Schema.Struct({ memory: Schema.optional(Schema.String) }))),
})

const AddResponse = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  results: Schema.optional(Schema.Array(AddResult)),
})
export type AddResponse = Schema.Schema.Type<typeof AddResponse>

export type Message = { role: "user" | "assistant" | "system"; content: string }

export type Scope = {
  userID: string
  agentID?: string
  runID?: string
}

export interface Client {
  readonly add: (input: {
    messages: Message[]
    scope: Scope
    metadata?: Record<string, string>
    /** false stores the text verbatim instead of running mem0's extraction pass */
    infer?: boolean
  }) => Effect.Effect<AddResponse, Mem0Error>
  readonly search: (input: {
    query: string
    scope: Scope
    limit?: number
    threshold?: number
  }) => Effect.Effect<Item[], Mem0Error>
  readonly list: (input: { scope: Scope; limit?: number }) => Effect.Effect<Item[], Mem0Error>
  readonly remove: (id: string) => Effect.Effect<void, Mem0Error>
}

function filters(scope: Scope) {
  const clauses: Record<string, string>[] = [{ user_id: scope.userID }]
  if (scope.agentID) clauses.push({ agent_id: scope.agentID })
  if (scope.runID) clauses.push({ run_id: scope.runID })
  if (clauses.length === 1) return clauses[0]
  return { AND: clauses }
}

export function make(input: { apiKey: string; baseURL?: string; http: HttpClient.HttpClient }): Client {
  const base = (input.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const http = HttpClient.filterStatusOk(input.http)

  const fail = (operation: string) => (cause: unknown) =>
    new Mem0Error({ operation, message: `mem0 ${operation} failed`, cause })

  const post = (operation: string, path: string, body: unknown) =>
    HttpClientRequest.post(`${base}${path}`).pipe(
      HttpClientRequest.acceptJson,
      // mem0 authenticates with a "Token" scheme rather than "Bearer".
      HttpClientRequest.setHeader("Authorization", `Token ${input.apiKey}`),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap((request) => http.execute(request)),
      Effect.mapError(fail(operation)),
    )

  const decode =
    <A, I>(operation: string, schema: Schema.Codec<A, I>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (cause) => new Mem0Error({ operation, message: `mem0 ${operation} returned an unexpected body`, cause }),
        ),
      )

  return {
    add: Effect.fn("Mem0.add")(function* (params) {
      const response = yield* post("add", "/v3/memories/add/", {
        messages: params.messages,
        user_id: params.scope.userID,
        ...(params.scope.agentID ? { agent_id: params.scope.agentID } : {}),
        ...(params.scope.runID ? { run_id: params.scope.runID } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(params.infer === undefined ? {} : { infer: params.infer }),
      })
      return yield* decode("add", AddResponse)(response)
    }),

    search: Effect.fn("Mem0.search")(function* (params) {
      const response = yield* post("search", "/v3/memories/search/", {
        query: params.query,
        filters: filters(params.scope),
        top_k: params.limit ?? 10,
        ...(params.threshold === undefined ? {} : { threshold: params.threshold }),
      })
      const parsed = yield* decode("search", SearchResponse)(response)
      return [...(parsed.results ?? [])]
    }),

    list: Effect.fn("Mem0.list")(function* (params) {
      const size = Math.min(params.limit ?? 100, 200)
      const response = yield* post("list", `/v3/memories/?page=1&page_size=${size}`, {
        filters: filters(params.scope),
      })
      const parsed = yield* decode("list", ListResponse)(response)
      return [...(parsed.results ?? [])]
    }),

    remove: Effect.fn("Mem0.remove")(function* (id) {
      // Deletion is still a v1 route; the v3 surface only covers add/search/list.
      yield* http
        .execute(
          HttpClientRequest.delete(`${base}/v1/memories/${encodeURIComponent(id)}/`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("Authorization", `Token ${input.apiKey}`),
          ),
        )
        .pipe(Effect.mapError(fail("remove")))
    }),
  }
}

export * as Mem0 from "./mem0"
