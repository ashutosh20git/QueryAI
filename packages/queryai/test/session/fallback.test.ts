import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { SessionV1 } from "@queryai/core/v1/session"
import { NamedError } from "@queryai/core/util/error"
import { ModelV2 } from "@queryai/core/model"
import { ProviderV2 } from "@queryai/core/provider"
import { ConfigV1 } from "@queryai/core/v1/config/config"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { SessionFallback } from "@/session/fallback"
import { SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const ses = SessionID.make("ses_test")

const model = (
  over: Omit<Partial<Provider.Model>, "id" | "providerID"> & { id: string; providerID: string },
): Provider.Model =>
  ({
    name: over.id,
    api: { id: "api", url: "https://example.test", npm: "pkg" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...over,
    id: ModelV2.ID.make(over.id),
    providerID: ProviderV2.ID.make(over.providerID),
  }) as Provider.Model

const api = (over: Partial<SessionV1.APIError["data"]>) =>
  new SessionV1.APIError({
    message: "boom",
    ...over,
  } as SessionV1.APIError["data"]).toObject()

describe("session.fallback classification", () => {
  test("a quota ceiling is hard and skips the backoff", () => {
    expect(SessionFallback.hard(api({ message: "You exceeded your current quota" }))).toBe(true)
    expect(SessionFallback.hard(api({ statusCode: 402, message: "Payment Required" }))).toBe(true)
    expect(SessionFallback.hard(api({ message: "429", responseBody: '{"type":"FreeUsageLimitError"}' }))).toBe(true)
    expect(SessionFallback.hard(api({ message: "RESOURCE_EXHAUSTED: quota" }))).toBe(true)
  })

  test("a plain rate limit is soft and is worth waiting out first", () => {
    expect(SessionFallback.soft(api({ statusCode: 429, message: "Too Many Requests" }))).toBe(true)
    expect(SessionFallback.soft(api({ statusCode: 503, message: "Overloaded" }))).toBe(true)
    expect(SessionFallback.hard(api({ statusCode: 429, message: "Too Many Requests" }))).toBe(false)
  })

  test("a 403 is an auth problem until it says otherwise", () => {
    // Every provider returns 403 for a revoked key, a model the account cannot
    // reach, and a blocked region. Walking to another provider on those buries a
    // failure the user has to fix.
    expect(SessionFallback.exhausted(api({ statusCode: 403, message: "Forbidden" }))).toBe(false)
    expect(SessionFallback.exhausted(api({ statusCode: 403, message: "invalid api key" }))).toBe(false)
    // One that really is a ceiling still says so in the body.
    expect(SessionFallback.hard(api({ statusCode: 403, message: "You exceeded your current quota" }))).toBe(true)
  })

  test("failures another model would hit too are not fallback material", () => {
    // Overflow is what compaction is for, and every model would reject the same payload.
    expect(SessionFallback.exhausted(new SessionV1.ContextOverflowError({ message: "too big" }).toObject())).toBe(false)
    // A dead network reproduces everywhere; burning a second key proves nothing.
    expect(SessionFallback.exhausted(api({ message: "fetch failed: ECONNREFUSED" }))).toBe(false)
    expect(SessionFallback.exhausted(new NamedError.Unknown({ message: "bad request" }).toObject())).toBe(false)
  })
})

describe("session.fallback ranking", () => {
  test("orders by level, most capable first", () => {
    const ranked = SessionFallback.rank([
      model({ id: "cheap", providerID: "p", cost: { input: 0, output: 0.1, cache: { read: 0, write: 0 } } }),
      model({ id: "flagship", providerID: "p", cost: { input: 0, output: 15, cache: { read: 0, write: 0 } } }),
      model({ id: "mid", providerID: "p", cost: { input: 0, output: 3, cache: { read: 0, write: 0 } } }),
    ])
    expect(ranked.map((m) => String(m.id))).toEqual(["flagship", "mid", "cheap"])
  })

  test("breaks price ties on context, then reasoning, then recency", () => {
    const flat = { input: 0, output: 1, cache: { read: 0, write: 0 } }
    const ranked = SessionFallback.rank([
      model({ id: "small-ctx", providerID: "p", cost: flat, limit: { context: 8_000, output: 1_000 } }),
      model({ id: "big-ctx", providerID: "p", cost: flat, limit: { context: 900_000, output: 1_000 } }),
    ])
    expect(ranked.map((m) => String(m.id))).toEqual(["big-ctx", "small-ctx"])

    const same = { context: 100_000, output: 1_000 }
    const byReasoning = SessionFallback.rank([
      model({ id: "plain", providerID: "p", cost: flat, limit: same }),
      model({
        id: "thinks",
        providerID: "p",
        cost: flat,
        limit: same,
        capabilities: { ...model({ id: "x", providerID: "p" }).capabilities, reasoning: true },
      }),
    ])
    expect(String(byReasoning[0].id)).toBe("thinks")
  })

  test("free models go first, however capable the paid ones are", () => {
    const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
    const ranked = SessionFallback.rank([
      model({ id: "flagship", providerID: "p", cost: { input: 0, output: 15, cache: { read: 0, write: 0 } } }),
      model({ id: "free-small", providerID: "q", cost: zero, limit: { context: 8_000, output: 1_000 } }),
      model({ id: "free-120b", providerID: "q", cost: zero, limit: { context: 8_000, output: 1_000 } }),
    ])
    // A fallback the user did not ask for must not start spending money while a
    // zero-cost model can still take the turn.
    expect(ranked.map((m) => String(m.id))).toEqual(["free-120b", "free-small", "flagship"])
  })

  test("drops models that cannot take over the turn", () => {
    const base = model({ id: "x", providerID: "p" })
    const ranked = SessionFallback.rank([
      model({ id: "keep", providerID: "p" }),
      // A model with no tool calling cannot drive the agent loop, however cheap.
      model({
        id: "no-tools",
        providerID: "p",
        capabilities: { ...base.capabilities, toolcall: false },
        cost: { input: 0, output: 99, cache: { read: 0, write: 0 } },
      }),
      model({ id: "gone", providerID: "p", status: "deprecated" }),
      model({ id: "unreleased", providerID: "p", status: "alpha" }),
    ])
    expect(ranked.map((m) => String(m.id))).toEqual(["keep"])
  })
})

const catalog = (models: Provider.Model[]) => {
  const byProvider: Record<string, any> = {}
  for (const m of models) {
    byProvider[m.providerID] ??= { id: m.providerID, name: m.providerID, source: "env", env: [], options: {}, models: {} }
    byProvider[m.providerID].models[m.id] = m
  }
  return Layer.succeed(
    Provider.Service,
    Provider.Service.of({
      list: () => Effect.succeed(byProvider),
      getModel: (providerID, modelID) => {
        const found = byProvider[providerID]?.models[modelID]
        if (!found) return Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
        return Effect.succeed(found)
      },
      getProvider: () => Effect.die("unused"),
      getLanguage: () => Effect.die("unused"),
      closest: () => Effect.succeed(undefined),
      getSmallModel: () => Effect.succeed(undefined),
      defaultModel: () => Effect.die("unused"),
    } as Provider.Interface),
  )
}

const cfgLayer = (fallback?: ConfigV1.Info["fallback"]) =>
  Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ fallback }) }))

const pool = [
  model({ id: "top", providerID: "alpha", cost: { input: 0, output: 15, cache: { read: 0, write: 0 } } }),
  model({ id: "mid", providerID: "beta", cost: { input: 0, output: 3, cache: { read: 0, write: 0 } } }),
  model({ id: "low", providerID: "gamma", cost: { input: 0, output: 0.5, cache: { read: 0, write: 0 } } }),
]

const harness = (fallback?: ConfigV1.Info["fallback"], models: Provider.Model[] = pool) =>
  testEffect(
    LayerNode.compile(LayerNode.group([SessionFallback.node]), [
      [Config.node, cfgLayer(fallback)],
      [Provider.node, catalog(models)],
    ]),
  )

const cand = (providerID: string, modelID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

const quota = api({ message: "You exceeded your current quota" })
const current = cand("alpha", "top")

describe("session.fallback chain", () => {
  const it = harness()

  it.instance("walks down the levels one model at a time", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      const first = yield* fallback.next({ sessionID: ses, current, error: quota })
      expect(first).toEqual(cand("beta", "mid"))

      const second = yield* fallback.next({ sessionID: ses, current: first!, error: quota })
      expect(second).toEqual(cand("gamma", "low"))

      // Everything is spent now, so the turn is allowed to fail.
      expect(yield* fallback.next({ sessionID: ses, current: second!, error: quota })).toBeUndefined()
    }),
  )

  it.instance("leaves errors a switch cannot fix alone", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      const network = api({ message: "fetch failed" })
      expect(yield* fallback.next({ sessionID: ses, current, error: network })).toBeUndefined()
    }),
  )

  it.instance("keeps a burned model out of later turns in the same session", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      yield* fallback.next({ sessionID: ses, current, error: quota })

      // A later turn still nominates the original model; it must not be retried.
      expect(yield* fallback.resolve({ sessionID: ses, preferred: current })).toEqual(cand("beta", "mid"))

      // A different session has burned nothing and starts from the top.
      const other = SessionID.make("ses_other")
      expect(yield* fallback.resolve({ sessionID: other, preferred: current })).toEqual(current)
    }),
  )

  it.instance("a model that was never burned is handed back untouched", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      expect(yield* fallback.resolve({ sessionID: ses, preferred: current })).toEqual(current)
    }),
  )

  it.instance("reset puts the session back at the top of the chain", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      yield* fallback.next({ sessionID: ses, current, error: quota })
      yield* fallback.reset(ses)
      expect(yield* fallback.resolve({ sessionID: ses, preferred: current })).toEqual(current)
    }),
  )
})

describe("session.fallback configuration", () => {
  const explicit = harness({ models: ["gamma/low", "beta/mid"] })

  explicit.instance("an explicit list is followed in the order written", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      // Ranking would have chosen beta/mid; the configured order wins.
      const first = yield* fallback.next({ sessionID: ses, current, error: quota })
      expect(first).toEqual(cand("gamma", "low"))
    }),
  )

  const missing = harness({ models: ["nope/ghost", "beta/mid"] })

  missing.instance("a configured model with no credential is skipped, not returned", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      expect(yield* fallback.next({ sessionID: ses, current, error: quota })).toEqual(cand("beta", "mid"))
    }),
  )

  const off = harness({ enabled: false })

  off.instance("disabling it restores the old fail-fast behaviour", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      expect(yield* fallback.next({ sessionID: ses, current, error: quota })).toBeUndefined()
      expect(yield* fallback.available({ sessionID: ses, current })).toBe(false)
    }),
  )

  const capped = harness({ max_switches: 1 })

  capped.instance("max_switches bounds how far one session will walk", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      const first = yield* fallback.next({ sessionID: ses, current, error: quota })
      expect(first).toEqual(cand("beta", "mid"))
      // Two models are now burned, which is past a budget of one.
      expect(yield* fallback.next({ sessionID: ses, current: first!, error: quota })).toBeUndefined()
    }),
  )

  const zeroed = harness({ max_switches: 0 })

  zeroed.instance("max_switches 0 turns fallback off rather than half-off", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      // `available` is what tells the retry policy whether waiting is pointless.
      // Answering yes here and then refusing to switch would spend the turn's
      // whole retry budget on nothing.
      expect(yield* fallback.available({ sessionID: ses, current })).toBe(false)
      expect(yield* fallback.next({ sessionID: ses, current, error: quota })).toBeUndefined()
    }),
  )

  const capped2 = harness({ max_switches: 2 })

  capped2.instance("the last switch in the budget is still offered up front", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      const first = yield* fallback.next({ sessionID: ses, current, error: quota })
      expect(first).toEqual(cand("beta", "mid"))
      // One switch spent of two: `available` and `next` must still agree.
      expect(yield* fallback.available({ sessionID: ses, current: first! })).toBe(true)
      expect(yield* fallback.next({ sessionID: ses, current: first!, error: quota })).toEqual(cand("gamma", "low"))
    }),
  )

  const alone = harness(undefined, [pool[0]])

  alone.instance("a single model means there is nowhere to fall back to", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      // Nothing to switch to, so the retry budget stays in charge and the turn
      // behaves exactly as it did before fallback existed.
      expect(yield* fallback.available({ sessionID: ses, current })).toBe(false)
      expect(yield* fallback.next({ sessionID: ses, current, error: quota })).toBeUndefined()
    }),
  )
})

const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const mixed = [
  model({ id: "free", providerID: "alpha", cost: zero }),
  model({ id: "free-too", providerID: "beta", cost: zero }),
  model({ id: "paid", providerID: "gamma", cost: { input: 1, output: 20, cache: { read: 0, write: 0 } } }),
]
const onFree = cand("alpha", "free")

describe("session.fallback cost", () => {
  const it = harness(undefined, mixed)

  it.instance("a free tier running out moves to another free model, not onto a paid key", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      expect(yield* fallback.next({ sessionID: ses, current: onFree, error: quota })).toEqual(cand("beta", "free-too"))
      // Both free models are gone now. The paid one is still there, and is still
      // not taken: the user chose a free model and never agreed to spend.
      expect(
        yield* fallback.next({ sessionID: ses, current: cand("beta", "free-too"), error: quota }),
      ).toBeUndefined()
    }),
  )

  it.instance("a paid model may fall back to anything no dearer than itself", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      const next = yield* fallback.next({ sessionID: ses, current: cand("gamma", "paid"), error: quota })
      expect(next).toEqual(cand("alpha", "free"))
    }),
  )

  const raised = harness({ max_cost: 25 }, mixed)

  raised.instance("max_cost is the way to allow an upgrade, and it is explicit", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      yield* fallback.next({ sessionID: ses, current: onFree, error: quota })
      expect(yield* fallback.next({ sessionID: ses, current: cand("beta", "free-too"), error: quota })).toEqual(
        cand("gamma", "paid"),
      )
    }),
  )

  const listed = harness({ models: ["gamma/paid"] }, mixed)

  listed.instance("an explicit chain is an instruction and outranks the price guard", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionFallback.Service
      expect(yield* fallback.next({ sessionID: ses, current: onFree, error: quota })).toEqual(cand("gamma", "paid"))
    }),
  )
})
