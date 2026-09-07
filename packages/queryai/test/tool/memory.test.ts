import { afterEach, describe, expect } from "bun:test"
import { rm } from "fs/promises"
import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { httpClient } from "@queryai/core/effect/app-node-platform"
import { Memory } from "@/memory/memory"
import { LocalMemory } from "@/memory/local"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { MemoryTool } from "@/tool/memory"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

let calls: { url: string; body: any }[] = []
let respond: () => Response = () => Response.json({})

// Pulling in Agent brings the provider catalog fetch along with it, so the
// transport only speaks for mem0 and leaves everything else inert.
const isMem0 = (url: string) => url.includes("/memories")

const transport = HttpClient.make((request) =>
  Effect.gen(function* () {
    if (!isMem0(request.url)) return HttpClientResponse.fromWeb(request, Response.json({}))
    const web = Result.getOrThrow(HttpClientRequest.toWebResult(request))
    const text = yield* Effect.promise(() => web.text())
    calls.push({ url: request.url, body: text ? JSON.parse(text) : undefined })
    return HttpClientResponse.fromWeb(request, respond())
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Memory.node, Truncate.node, Agent.node]), [
    [httpClient, Layer.succeed(HttpClient.HttpClient, transport) as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const asked: { permission: string; patterns: readonly string[] }[] = []

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input: { permission: string; patterns: readonly string[] }) =>
    Effect.sync(() => {
      asked.push({ permission: input.permission, patterns: input.patterns })
    }),
}

const exec = Effect.fn("MemoryToolTest.exec")(function* (args: Tool.InferParameters<typeof MemoryTool>) {
  const info = yield* MemoryTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx as unknown as Parameters<typeof tool.execute>[1])
})

const KEY = "test-key"
const enabled = { config: { memory: { api_key: KEY } } }

const row = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  memory: "prefers pnpm",
  metadata: { scope: "project" },
  ...over,
})

afterEach(async () => {
  calls = []
  asked.length = 0
  respond = () => Response.json({})
  await rm(LocalMemory.file(Memory.localUserID()), { force: true })
})

describe("tool.memory", () => {
  it.instance(
    "remember writes the fact and reports the scope it landed in",
    () =>
      Effect.gen(function* () {
        const result = yield* exec({ action: "remember", text: "  prefers pnpm  ", scope: "user" })
        expect(result.output).toBe("Remembered: prefers pnpm")
        expect(result.title).toBe("remembered (user)")
        // Whitespace the model padded the argument with must not reach storage.
        expect(calls[0].body.messages).toEqual([{ role: "user", content: "prefers pnpm" }])
        // The action is the permission pattern, so a user can allow search while
        // still being asked about writes.
        expect(asked).toEqual([{ permission: "memory", patterns: ["remember"] }])
      }),
    enabled,
  )

  it.instance(
    "search and list render ids the model can hand back to forget",
    () =>
      Effect.gen(function* () {
        respond = () => Response.json({ results: [row(), row({ id: "m2", memory: "call me Ash" })] })

        const search = yield* exec({ action: "search", query: "package manager" })
        expect(search.title).toBe("2 memories")
        expect(search.output).toContain("- [m1] (project) prefers pnpm")
        expect(search.metadata.count).toBe(2)

        const list = yield* exec({ action: "list" })
        expect(list.output).toContain("- [m2] (project) call me Ash")
      }),
    enabled,
  )

  it.instance(
    "an empty result set reads as empty rather than as a failure",
    () =>
      Effect.gen(function* () {
        respond = () => Response.json({ results: [] })
        expect((yield* exec({ action: "search", query: "nothing" })).output).toBe("No matching memories.")
        expect((yield* exec({ action: "list" })).output).toBe("No memories stored.")
      }),
    enabled,
  )

  it.instance(
    "forget deletes by id",
    () =>
      Effect.gen(function* () {
        const result = yield* exec({ action: "forget", id: "m1" })
        expect(result.output).toBe("Deleted memory m1")
        expect(calls[0].url).toBe("https://api.mem0.ai/v1/memories/m1/")
      }),
    enabled,
  )

  it.instance(
    "a missing argument is answered, not thrown",
    () =>
      Effect.gen(function* () {
        expect((yield* exec({ action: "remember" })).output).toBe("remember requires 'text'")
        expect((yield* exec({ action: "search", query: "  " })).output).toBe("search requires 'query'")
        expect((yield* exec({ action: "forget" })).output).toBe("forget requires 'id'")
        expect(calls).toHaveLength(0)
      }),
    enabled,
  )

  it.instance(
    "a backend outage reads as a failed call the model can react to",
    () =>
      Effect.gen(function* () {
        respond = () => new Response("boom", { status: 500 })
        const result = yield* exec({ action: "search", query: "q" })
        expect(result.title).toBe("memory unavailable")
        expect(result.output).toContain("mem0 search failed")
      }),
    enabled,
  )

  it.instance("with no credential at all the tool still works, against the local store", () =>
    Effect.gen(function* () {
      const write = yield* exec({ action: "remember", text: "prefers pnpm" })
      expect(write.output).toBe("Remembered: prefers pnpm")
      // Nothing left the machine.
      expect(calls).toHaveLength(0)

      // Local search is term overlap, not embeddings: it finds the row a word
      // points at, and says so when nothing matches.
      const hit = yield* exec({ action: "search", query: "is pnpm used here" })
      expect(hit.output).toContain("prefers pnpm")
      expect((yield* exec({ action: "search", query: "deployment pipeline" })).output).toBe("No matching memories.")
    }),
  )

  it.instance(
    "asking for mem0 without a key explains what is missing instead of falling back",
    () =>
      Effect.gen(function* () {
        const result = yield* exec({ action: "remember", text: "prefers pnpm" })
        expect(result.title).toBe("memory unavailable")
        expect(result.output).toContain(Memory.API_KEY_ENV)
      }),
    { config: { memory: { backend: "mem0" as const } } },
  )
})
