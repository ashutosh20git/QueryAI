import { afterEach, expect } from "bun:test"
import { rm } from "fs/promises"
import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { httpClient } from "@queryai/core/effect/app-node-platform"
import { Memory } from "@/memory/memory"
import { LocalMemory } from "@/memory/local"
import { testEffect } from "../lib/effect"

type Captured = {
  method: string
  url: string
  body: any
}

/**
 * The layer is compiled once for the whole file, so the transport is a stable
 * shell around a per-test route table rather than a fresh client each time.
 */
let calls: Captured[] = []
let respond: (call: Captured) => Response = () => Response.json({})

const transport = HttpClient.make((request) =>
  Effect.gen(function* () {
    const web = Result.getOrThrow(HttpClientRequest.toWebResult(request))
    const text = yield* Effect.promise(() => web.text())
    const call = { method: request.method, url: request.url, body: text ? JSON.parse(text) : undefined }
    calls.push(call)
    return HttpClientResponse.fromWeb(request, respond(call))
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Memory.node]), [
    [httpClient, Layer.succeed(HttpClient.HttpClient, transport) as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const KEY = "test-key"
const enabled = { config: { memory: { api_key: KEY } } }

const results = (items: unknown[]) => (call: Captured) =>
  call.url.includes("/search/") || call.url.includes("/v3/memories/?")
    ? Response.json({ results: items })
    : Response.json({ event_id: "e1", results: [] })

const row = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  memory: "prefers pnpm",
  metadata: { scope: "project" },
  created_at: "2026-09-01T00:00:00Z",
  score: 0.9,
  ...over,
})

afterEach(async () => {
  calls = []
  respond = () => Response.json({})
  delete process.env["MEM0_API_KEY"]
  // The local store is a real file shared by every test in this process, so it
  // is cleared between them the way the request log is.
  await rm(LocalMemory.file(Memory.localUserID()), { force: true })
})

it.instance(
  "with no credential memory runs locally rather than not at all",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.enabled()).toBe(true)
      expect(yield* memory.backend()).toBe("local")
      expect(yield* memory.userID()).toBe(Memory.localUserID())

      yield* memory.remember({ text: "prefers pnpm" })
      expect((yield* memory.list()).map((m) => m.text)).toEqual(["prefers pnpm"])
      // Nothing is sent anywhere: the store is a file on this machine.
      expect(calls).toHaveLength(0)
    }),
  // First test in the file, so it pays for building the layer.
  30_000,
)

it.instance(
  "an explicit local backend ignores a key that is present",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.backend()).toBe("local")
      yield* memory.remember({ text: "call me Ash", scope: "user" })
      expect(calls).toHaveLength(0)
      expect((yield* memory.list({ scope: "user" })).map((m) => m.text)).toEqual(["call me Ash"])
    }),
  { config: { memory: { backend: "local" as const, api_key: KEY } } },
)

it.instance(
  "the mem0 backend without a key is off, and says which key it wanted",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.enabled()).toBe(false)
      expect(yield* memory.backend()).toBeUndefined()

      // Recall is on the prompt path and must degrade silently, but an explicit
      // tool call should say why nothing happened.
      expect(yield* memory.recall({ query: "anything" })).toBeUndefined()
      const exit = yield* Effect.exit(memory.remember({ text: "prefers pnpm" }))
      expect(exit._tag).toBe("Failure")
      expect(calls).toHaveLength(0)
    }),
  { config: { memory: { backend: "mem0" as const } } },
)

it.instance(
  "turning memory off leaves nothing behind it",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.enabled()).toBe(false)
      expect(yield* memory.backend()).toBeUndefined()
    }),
  { config: { memory: { enabled: false } } },
)

it.instance(
  "a config key turns memory on and scopes writes to a stable local user",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.enabled()).toBe(true)
      const id = yield* memory.userID()
      // No account is logged in, so writes land under the per-machine id.
      expect(id).toBe(Memory.localUserID())
    }),
  enabled,
)

it.instance(
  "an explicit enabled:false wins over a present credential",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.enabled()).toBe(false)
    }),
  { config: { memory: { enabled: false, api_key: KEY } } },
)

it.instance("the api key falls back to the environment", () =>
  Effect.gen(function* () {
    process.env[Memory.API_KEY_ENV] = "from-env"
    const memory = yield* Memory.Service
    expect(yield* memory.enabled()).toBe(true)
  }),
)

it.instance(
  "remember stores the text verbatim under the requested scope",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.remember({ text: "prefers pnpm", agent: "build", sessionID: "ses_1" })
      yield* memory.remember({ text: "call me Ash", scope: "user" })

      expect(calls).toHaveLength(2)
      expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/add/")
      expect(calls[0].body.messages).toEqual([{ role: "user", content: "prefers pnpm" }])
      expect(calls[0].body.agent_id).toBe("build")
      expect(calls[0].body.run_id).toBe("ses_1")
      expect(calls[0].body.metadata.scope).toBe("project")
      expect(calls[0].body.metadata.project).toBeString()
      // An explicit fact is already phrased for storage; extraction would only
      // paraphrase it or drop it.
      expect(calls[0].body.infer).toBe(false)

      // A user-scoped fact follows the person, so it carries no project.
      expect(calls[1].body.metadata).toEqual({ scope: "user" })
    }),
  enabled,
)

it.instance(
  "recall renders the matching rows and drops other projects",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = results([
        row(),
        row({ id: "m2", memory: "call me Ash", metadata: { scope: "user" } }),
        row({ id: "m3", memory: "elsewhere", metadata: { scope: "project", project: "some-other-project" } }),
      ])

      const block = yield* memory.recall({ query: "which package manager?", agent: "build" })
      expect(block).toContain(`<item id="m1" scope="project">prefers pnpm</item>`)
      expect(block).toContain(`<item id="m2" scope="user">call me Ash</item>`)
      expect(block).not.toContain("elsewhere")
      expect(calls[0].body.query).toBe("which package manager?")
      expect(calls[0].body.filters).toEqual({ AND: [{ user_id: Memory.localUserID() }, { agent_id: "build" }] })
    }),
  enabled,
)

it.instance(
  "recall swallows a failing backend rather than the turn",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = () => new Response("boom", { status: 500 })
      expect(yield* memory.recall({ query: "anything" })).toBeUndefined()
      expect(calls).toHaveLength(1)
    }),
  enabled,
)

it.instance(
  "recall skips the round trip when there is nothing to key off",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      expect(yield* memory.recall({ query: "   " })).toBeUndefined()
      expect(calls).toHaveLength(0)
    }),
  enabled,
)

it.instance(
  "list filters by scope and forget deletes by id",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = results([row(), row({ id: "m2", memory: "call me Ash", metadata: { scope: "user" } })])

      expect((yield* memory.list()).map((m) => m.id)).toEqual(["m1", "m2"])
      expect((yield* memory.list({ scope: "user" })).map((m) => m.id)).toEqual(["m2"])

      yield* memory.forget("m1")
      const remove = calls.at(-1)!
      expect(remove.method).toBe("DELETE")
      expect(remove.url).toBe("https://api.mem0.ai/v1/memories/m1/")
    }),
  enabled,
)

it.instance(
  "capture is inert unless auto_capture is turned on",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.capture({ messages: [{ role: "user", content: "we use pnpm here" }] })
      expect(calls).toHaveLength(0)
    }),
  enabled,
)

it.instance(
  "capture hands the turn to mem0 for extraction when enabled",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.capture({ messages: [{ role: "user", content: "we use pnpm here" }], sessionID: "ses_1" })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/add/")
      // Extraction is the whole point of auto-capture, so `infer` is left alone.
      expect(calls[0].body.infer).toBeUndefined()
      expect(calls[0].body.metadata.session).toBe("ses_1")
    }),
  { config: { memory: { api_key: KEY, auto_capture: true } } },
)

it.instance(
  "a failed capture never surfaces to the caller",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = () => new Response("boom", { status: 500 })
      yield* memory.capture({ messages: [{ role: "user", content: "we use pnpm here" }] })
      expect(calls).toHaveLength(1)
    }),
  { config: { memory: { api_key: KEY, auto_capture: true } } },
)

it.instance(
  "project scoping off keeps every row this user owns",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = results([row(), row({ id: "m3", metadata: { scope: "project", project: "some-other-project" } })])
      expect((yield* memory.search({ query: "q" })).map((m) => m.id)).toEqual(["m1", "m3"])
    }),
  { config: { memory: { api_key: KEY, project_scope: false } } },
)

it.instance(
  "a self-hosted base url keeps traffic off the platform",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      respond = results([])
      yield* memory.search({ query: "q" })
      expect(calls[0].url).toBe("https://mem0.internal/v3/memories/search/")
    }),
  { config: { memory: { api_key: KEY, base_url: "https://mem0.internal/" } } },
)
