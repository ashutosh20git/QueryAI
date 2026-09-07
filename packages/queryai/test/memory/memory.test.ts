import { expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Mem0 } from "@/memory/mem0"
import { Memory } from "@/memory/memory"

type Captured = {
  method: string
  url: string
  authorization: string | null
  body: unknown
}

const recorder = (body: unknown = {}) => {
  const calls: Captured[] = []
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = Result.getOrThrow(HttpClientRequest.toWebResult(request))
      const text = yield* Effect.promise(() => web.text())
      calls.push({
        method: request.method,
        url: request.url,
        authorization: request.headers["authorization"] ?? null,
        body: text ? JSON.parse(text) : undefined,
      })
      return HttpClientResponse.fromWeb(request, Response.json(body))
    }),
  )
  return { calls, client }
}

const item = (over: Partial<Mem0.Item> = {}): Mem0.Item => ({
  id: "m1",
  memory: "prefers pnpm",
  metadata: { scope: "project", project: "proj-1" },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: null,
  score: 0.9,
  ...over,
})

test("add posts the v3 route with token auth and scoping", async () => {
  const { calls, client } = recorder({ event_id: "e1", status: "PENDING", results: [] })
  const mem0 = Mem0.make({ apiKey: "secret", http: client })

  await Effect.runPromise(
    mem0.add({
      messages: [{ role: "user", content: "prefers pnpm" }],
      scope: { userID: "acct_1", agentID: "build", runID: "ses_1" },
      metadata: { scope: "project", project: "proj-1" },
      infer: false,
    }),
  )

  expect(calls).toHaveLength(1)
  const call = calls[0]
  expect(call.method).toBe("POST")
  expect(call.url).toBe("https://api.mem0.ai/v3/memories/add/")
  expect(call.authorization).toBe("Token secret")
  expect(call.body).toEqual({
    messages: [{ role: "user", content: "prefers pnpm" }],
    user_id: "acct_1",
    agent_id: "build",
    run_id: "ses_1",
    metadata: { scope: "project", project: "proj-1" },
    infer: false,
  })
})

test("search sends an AND filter over the entity ids", async () => {
  const { calls, client } = recorder({ results: [item()] })
  const mem0 = Mem0.make({ apiKey: "secret", http: client })

  const results = await Effect.runPromise(
    mem0.search({ query: "package manager", scope: { userID: "acct_1", agentID: "build" }, limit: 5 }),
  )

  expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/search/")
  expect(calls[0].body).toEqual({
    query: "package manager",
    filters: { AND: [{ user_id: "acct_1" }, { agent_id: "build" }] },
    top_k: 5,
  })
  expect(results.map((r) => r.id)).toEqual(["m1"])
})

test("search filter collapses to a bare user id when unscoped", async () => {
  const { calls, client } = recorder({ results: [] })
  const mem0 = Mem0.make({ apiKey: "secret", http: client })

  await Effect.runPromise(mem0.search({ query: "anything", scope: { userID: "acct_1" } }))

  expect(calls[0].body).toMatchObject({ filters: { user_id: "acct_1" } })
})

test("list pages the v3 route and delete uses the v1 route", async () => {
  const { calls, client } = recorder({ count: 1, results: [item()] })
  const mem0 = Mem0.make({ apiKey: "secret", http: client })

  await Effect.runPromise(mem0.list({ scope: { userID: "acct_1" }, limit: 400 }))
  await Effect.runPromise(mem0.remove("m 1/2"))

  // page_size is clamped to the documented maximum
  expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/?page=1&page_size=200")
  expect(calls[1].method).toBe("DELETE")
  expect(calls[1].url).toBe("https://api.mem0.ai/v1/memories/m%201%2F2/")
  expect(calls[1].authorization).toBe("Token secret")
})

test("a self-hosted base url replaces the platform host", async () => {
  const { calls, client } = recorder({ results: [] })
  const mem0 = Mem0.make({ apiKey: "secret", baseURL: "https://mem0.internal/", http: client })

  await Effect.runPromise(mem0.search({ query: "q", scope: { userID: "acct_1" } }))

  expect(calls[0].url).toBe("https://mem0.internal/v3/memories/search/")
})

test("unknown response fields are ignored rather than failing the call", async () => {
  const { client } = recorder({
    results: [{ ...item(), categories: ["preferences"], score_breakdown: { semantic: 0.4 }, unexpected: true }],
  })
  const mem0 = Mem0.make({ apiKey: "secret", http: client })

  const results = await Effect.runPromise(mem0.search({ query: "q", scope: { userID: "acct_1" } }))
  expect(results[0].memory).toBe("prefers pnpm")
})

test("a failed request surfaces as Mem0Error rather than a defect", async () => {
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("nope", { status: 401 }))),
  )
  const mem0 = Mem0.make({ apiKey: "bad", http: client })

  const exit = await Effect.runPromise(Effect.exit(mem0.search({ query: "q", scope: { userID: "acct_1" } })))
  expect(exit._tag).toBe("Failure")
})

test("project scoping keeps user-scoped and unscoped rows", () => {
  const input = { projectScope: true, project: "proj-1" }
  expect(belongsTo(item({ metadata: { scope: "project", project: "proj-1" } }), input)).toBe(true)
  expect(belongsTo(item({ metadata: { scope: "project", project: "other" } }), input)).toBe(false)
  expect(belongsTo(item({ metadata: { scope: "user" } }), input)).toBe(true)
  expect(belongsTo(item({ metadata: null }), input)).toBe(true)
  // scoping off means every row this user owns is fair game
  expect(belongsTo(item({ metadata: { scope: "project", project: "other" } }), { ...input, projectScope: false })).toBe(
    true,
  )
})

const belongsTo = Memory.belongs

test("select drops empty rows and stops at the limit", () => {
  const items = [
    item({ id: "a" }),
    item({ id: "blank", memory: "   " }),
    item({ id: "b" }),
    item({ id: "c" }),
    item({ id: "elsewhere", metadata: { scope: "project", project: "other" } }),
  ]
  const picked = Memory.select(items, { projectScope: true, project: "proj-1", limit: 2 })
  expect(picked.map((p) => p.id)).toEqual(["a", "b"])
})

test("block renders scoped items and returns undefined when empty", () => {
  const rendered = Memory.block(
    [
      { id: "a", text: "prefers pnpm", scope: "project" },
      { id: "b", text: "call me Ash", scope: "user" },
    ],
    4000,
  )
  expect(rendered).toContain(`<item id="a" scope="project">prefers pnpm</item>`)
  expect(rendered).toContain(`<item id="b" scope="user">call me Ash</item>`)
  expect(Memory.block([], 4000)).toBeUndefined()
})

test("block stops at the character budget", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`,
    text: "x".repeat(100),
    scope: "project" as const,
  }))
  const rendered = Memory.block(items, 300)
  const count = (rendered?.match(/<item /g) ?? []).length
  expect(count).toBeGreaterThan(0)
  expect(count).toBeLessThan(4)
})

test("a memory that is only whitespace is not an item", () => {
  expect(Memory.toInfo(item({ memory: "  " }))).toBeUndefined()
  expect(Memory.toInfo(item({ memory: undefined }))).toBeUndefined()
})

test("the local user id is stable across calls", () => {
  expect(Memory.localUserID()).toBe(Memory.localUserID())
  expect(Memory.localUserID().startsWith("local:")).toBe(true)
})
