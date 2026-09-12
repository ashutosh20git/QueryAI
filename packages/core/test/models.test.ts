import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Exit, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@queryai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@queryai/core/effect/app-node-platform"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { Flag } from "@queryai/core/flag/flag"
import { Global } from "@queryai/core/global"
import { ModelsDev } from "@queryai/core/models-dev"
import { it } from "./lib/effect"
import { readFile, rm, writeFile, utimes, mkdir } from "fs/promises"
import path from "path"

// test/preload.ts pins QUERYAI_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.QUERYAI_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.QUERYAI_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.QUERYAI_MODELS_PATH = undefined
  Flag.QUERYAI_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.QUERYAI_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.QUERYAI_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

const cacheFile = path.join(Global.Path.cache, "models.json")

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

const legacyFixture: Record<string, ModelsDev.Provider> = {
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    models: {
      "zen-1": {
        id: "zen-1",
        name: "Zen One",
        release_date: "2026-03-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required because the ModelsDev implementation is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeMockClient(state))],
    ]),
  )

const writeCacheText = (text: string, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile, text)
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const writeCache = (data: object, mtimeMs?: number) => writeCacheText(JSON.stringify(data), mtimeMs)

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
})

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() returns empty catalog when disk empty, fetch disabled, and no bundled snapshot is injected", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual({})
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() recovers from a corrupted cache file by fetching a fresh catalog", () =>
    Effect.gen(function* () {
      yield* writeCacheText("{")
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const context = yield* Layer.build(buildLayer(state))
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Flag.QUERYAI_DISABLE_MODELS_FETCH = false
        }),
        () => ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(context)),
        () =>
          Effect.sync(() => {
            Flag.QUERYAI_DISABLE_MODELS_FETCH = true
          }),
      )
      expect(result).toEqual(fixture2)
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture2))
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
    }),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
    }),
  )

  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // mutate disk between calls — cache should mask the change
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(fixture)
      expect(first.b).toEqual(fixture)
    }),
  )

  it.live("refresh(true) fetches via HttpClient and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(fixture)
      expect(result.after).toEqual(fixture2)
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toContain("/api.json")
      expect(final.calls[0].userAgent).toContain("/cli")
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      // Fresh: mtime within the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.refresh(false)),
      )
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(after).toEqual(fixture2)
    }),
  )

  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(fixture)
      // retryTransient retries 5xx, so calls may be > 1.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("get() drops the upstream hosted provider", () =>
    Effect.gen(function* () {
      yield* writeCache(legacyFixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result)).toEqual([])
    }),
  )
})

describe("ModelsDev.alias", () => {
  it.effect("drops the upstream hosted provider under its original ids", () =>
    Effect.sync(() => {
      const result = ModelsDev.alias({
        ...legacyFixture,
        "opencode-go": { ...legacyFixture["opencode"], id: "opencode-go", name: "OpenCode Go" },
      })
      expect(Object.keys(result)).toEqual([])
    }),
  )

  it.effect("drops the renamed ids the catalog used to be shown under", () =>
    Effect.sync(() => {
      const current = { ...legacyFixture["opencode"], id: "queryai", name: "QueryAI Zen", env: ["QUERYAI_API_KEY"] }
      expect(ModelsDev.alias({ opencode: legacyFixture["opencode"], queryai: current })).toEqual({})
    }),
  )

  it.effect("passes unrelated providers through", () =>
    Effect.sync(() => {
      expect(ModelsDev.alias(fixture)).toEqual(fixture)
    }),
  )

  it.effect("aliasID leaves every id alone", () =>
    Effect.sync(() => {
      expect(ModelsDev.aliasID("opencode")).toBe("opencode")
      expect(ModelsDev.aliasID("queryai")).toBe("queryai")
      expect(ModelsDev.aliasID("anthropic")).toBe("anthropic")
    }),
  )
})

// populate is orDie, so a source that cannot be reached takes the whole CLI down
// rather than degrading: not one model can be named. The default is public and
// the mirror only backs it up, so both halves of that order are pinned here.
describe("ModelsDev catalog source", () => {
  const routed = (state: Ref.Ref<MockState>, reply: (url: string) => Response) =>
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(state, (s) => ({
          ...s,
          calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
        }))
        return HttpClientResponse.fromWeb(request, reply(request.url))
      }),
    )

  const withFetch = <A, E>(eff: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Flag.QUERYAI_DISABLE_MODELS_FETCH = false
      }),
      () => eff,
      () =>
        Effect.sync(() => {
          Flag.QUERYAI_DISABLE_MODELS_FETCH = true
        }),
    )

  const build = (state: Ref.Ref<MockState>, reply: (url: string) => Response) =>
    Layer.fresh(
      AppNodeBuilder.build(ModelsDev.node, [
        [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, routed(state, reply))],
      ]),
    )

  it.live("falls back to the mirror when the default source is unreachable", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<MockState>({ ...initialState, calls: [] })
      const context = yield* Layer.build(
        build(state, (url) =>
          url.startsWith(ModelsDev.DEFAULT_SOURCE)
            ? new Response("Not Found", { status: 404 })
            : new Response(JSON.stringify(fixture2), { status: 200 }),
        ),
      )
      const result = yield* withFetch(ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(context)))

      expect(result).toEqual(fixture2)
      const final = yield* Ref.get(state)
      // Mirror first, upstream only after it fails.
      expect(final.calls[0].url).toBe(`${ModelsDev.DEFAULT_SOURCE}/api.json`)
      expect(final.calls.at(-1)!.url).toBe(`${ModelsDev.MIRROR_SOURCE}/api.json`)
    }),
  )

  it.live("does not reach for the mirror while the default source is serving", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<MockState>({ ...initialState, calls: [] })
      const context = yield* Layer.build(build(state, () => new Response(JSON.stringify(fixture), { status: 200 })))
      const result = yield* withFetch(ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(context)))

      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls.every((call) => call.url.startsWith(ModelsDev.DEFAULT_SOURCE))).toBe(true)
    }),
  )

  it.live("honours an explicit QUERYAI_MODELS_URL instead of silently serving upstream", () =>
    Effect.gen(function* () {
      const original = Flag.QUERYAI_MODELS_URL
      Flag.QUERYAI_MODELS_URL = "https://catalog.example.com"
      const state = yield* Ref.make<MockState>({ ...initialState, calls: [] })
      const context = yield* Layer.build(build(state, () => new Response("Not Found", { status: 404 })))
      // populate is orDie, so an unreachable configured source surfaces as a
      // defect rather than a typed failure - exit captures both.
      const result = yield* withFetch(
        ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(context), Effect.exit),
      ).pipe(Effect.ensuring(Effect.sync(() => (Flag.QUERYAI_MODELS_URL = original))))

      // A configured source that fails is an error to surface, not a cue to go
      // fetch someone else's catalog behind the user's back.
      expect(Exit.isSuccess(result)).toBe(false)
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThan(0)
      expect(final.calls.every((call) => call.url.startsWith("https://catalog.example.com"))).toBe(true)
    }),
  )
})
