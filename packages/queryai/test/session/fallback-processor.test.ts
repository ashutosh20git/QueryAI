import { describe, expect } from "bun:test"
import { APICallError } from "ai"
import { Effect, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { ConfigV1 } from "@queryai/core/v1/config/config"
import { Database } from "@queryai/core/database/database"
import { AppNodeBuilder } from "@queryai/core/effect/app-node-builder"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@queryai/core/cross-spawn-spawner"
import { ModelV2 } from "@queryai/core/model"
import { ProviderV2 } from "@queryai/core/provider"
import { SessionProjector } from "@queryai/core/session/projector"
import { LLMEvent } from "@queryai/llm"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionSummary } from "@/session/summary"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const summaryLayer = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const flagship = ProviderTest.model({
  id: ModelV2.ID.make("flagship"),
  providerID: ProviderV2.ID.make("primary"),
  cost: { input: 3, output: 15, cache: { read: 0, write: 0 } },
})

const backup = ProviderTest.model({
  id: ModelV2.ID.make("backup"),
  providerID: ProviderV2.ID.make("secondary"),
  cost: { input: 0, output: 1, cache: { read: 0, write: 0 } },
})

const providers = {
  primary: ProviderTest.info({ id: flagship.providerID }, flagship),
  secondary: ProviderTest.info({ id: backup.providerID }, backup),
}

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: () => Effect.succeed(providers as Record<ProviderV2.ID, Provider.Info>),
    getProvider: (id) => Effect.succeed((providers as any)[id]),
    getModel: (providerID, modelID) => {
      const found = (providers as any)[providerID]?.models[modelID]
      if (!found) return Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
      return Effect.succeed(found)
    },
    getLanguage: () => Effect.die("unused"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed({ providerID: flagship.providerID, modelID: flagship.id }),
  } as Provider.Interface),
)

const cfg = (fallback?: ConfigV1.Info["fallback"]) => {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, fallback }) }))
}

/**
 * Fails the way a spent free key does: a 429 whose body names the quota. The
 * provider's own retryable hint is a parameter because the two paths under test
 * diverge on it - with fallback on, the hint is overridden and the backoff is
 * skipped; with fallback off, the old retry behaviour is what should remain.
 */
const quotaFailure = (isRetryable = true) =>
  Stream.fromAsyncIterable(
    {
      async *[Symbol.asyncIterator]() {
        yield LLMEvent.stepStart({ index: 0 })
        throw new APICallError({
          message: "You exceeded your current quota",
          url: "https://example.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: {},
          responseBody: '{"error":{"type":"insufficient_quota"}}',
          isRetryable,
        })
      },
    },
    (err) => err,
  )

/** Emits real content and only then dies, so the attempt has something worth keeping. */
const textThenQuota = () =>
  Stream.fromAsyncIterable(
    {
      async *[Symbol.asyncIterator]() {
        yield LLMEvent.stepStart({ index: 0 })
        yield LLMEvent.textStart({ id: "txt-0" })
        yield LLMEvent.textDelta({ id: "txt-0", text: "half an answer" })
        throw new APICallError({
          message: "You exceeded your current quota",
          url: "https://example.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: {},
          responseBody: '{"error":{"type":"insufficient_quota"}}',
          isRetryable: true,
        })
      },
    },
    (err) => err,
  )

const textReply = (text: string) =>
  Stream.make(
    LLMEvent.textStart({ id: "txt-0" }),
    LLMEvent.textDelta({ id: "txt-0", text }),
    LLMEvent.textEnd({ id: "txt-0" }),
  )

function stubLLM() {
  const seen: string[] = []
  const queue: Array<Stream.Stream<LLMEvent, unknown>> = []
  return {
    seen,
    push: (stream: Stream.Stream<LLMEvent, unknown>) => queue.push(stream),
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          seen.push(`${input.model.providerID}/${input.model.id}`)
          return queue.shift() ?? Stream.empty
        },
      }),
    ),
  }
}

const node = LayerNode.group([
  SessionProcessor.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])

const harness = (llm: Layer.Layer<LLM.Service>, fallback?: ConfigV1.Info["fallback"]) =>
  testEffect(
    AppNodeBuilder.build(node, [
      [Provider.node, providerLayer],
      [LLM.node, llm],
      [Config.node, cfg(fallback)],
      [SessionSummary.node, summaryLayer],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ]),
  )

const seed = Effect.fn("FallbackProcessorTest.seed")(function* () {
  const ssn = yield* SessionNs.Service
  const session = yield* ssn.create({})
  const user = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: session.id,
    agent: "build",
    model: { providerID: flagship.providerID, modelID: flagship.id },
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "hello",
  })
  const assistant = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: session.id,
    mode: "build",
    agent: "build",
    parentID: user.id,
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: flagship.id,
    providerID: flagship.providerID,
    time: { created: Date.now() },
  })
  return { session, user, assistant }
})

const streamInput = (user: any, model: Provider.Model, sessionID: SessionID) =>
  ({
    user,
    agent: { name: "build" },
    sessionID,
    system: [],
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    tools: {},
    model,
  }) as unknown as LLM.StreamInput

describe("session.fallback in the processor", () => {
  const spent = stubLLM()
  spent.push(quotaFailure())
  const it = harness(spent.layer)

  it.instance("a spent key ends the attempt as a switch, not a failure", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      const result = yield* handle.process(streamInput(user, flagship, session.id))

      expect(result).toBe("fallback")
      expect(handle.fallback).toEqual({ providerID: backup.providerID, modelID: backup.id })
      // The turn is moving, not failing - nothing should be recorded as an error.
      expect(handle.message.error).toBeUndefined()
      // A quota ceiling is not worth waiting out, so the backoff is skipped and
      // only the one doomed request is made.
      expect(spent.seen).toEqual(["primary/flagship"])
    }),
  )

  const dropped = stubLLM()
  dropped.push(quotaFailure())
  const itDropped = harness(dropped.layer)

  itDropped.instance("an attempt that produced nothing leaves no message behind", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const ssn = yield* SessionNs.Service
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      expect(yield* handle.process(streamInput(user, flagship, session.id))).toBe("fallback")

      // The empty turn is deleted, and nothing writes it back on the way out -
      // otherwise every switch would leave a content-less assistant message in
      // the history, with its orphaned parts.
      const messages = yield* ssn.messages({ sessionID: session.id })
      expect(messages.map((m) => m.info.id)).toEqual([user.id])
      expect(messages.flatMap((m) => m.parts.filter((p) => p.messageID === assistant.id))).toHaveLength(0)
    }),
  )

  const partial = stubLLM()
  partial.push(textThenQuota())
  const itPartial = harness(partial.layer)

  itPartial.instance("an attempt that did produce something is kept, closed out and error-free", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const ssn = yield* SessionNs.Service
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      expect(yield* handle.process(streamInput(user, flagship, session.id))).toBe("fallback")

      const messages = yield* ssn.messages({ sessionID: session.id })
      const kept = messages.find((m) => m.info.id === assistant.id)
      expect(kept).toBeDefined()
      expect(kept!.parts.some((p) => p.type === "text" && p.text === "half an answer")).toBe(true)
      // Changing model is not failing, so the user sees the text with no error.
      expect(kept!.info.role === "assistant" && kept!.info.error).toBeUndefined()
      expect(kept!.info.role === "assistant" && kept!.info.time.completed).toBeDefined()
    }),
  )

  const off = stubLLM()
  off.push(quotaFailure(false))
  const itOff = harness(off.layer, { enabled: false })

  itOff.instance("with fallback disabled the turn fails as it always did", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      const result = yield* handle.process(streamInput(user, flagship, session.id))

      expect(result).toBe("stop")
      expect(handle.fallback).toBeUndefined()
      expect(handle.message.error).toBeDefined()

      // And the failure is on the stored message, not only on the handle.
      const ssn = yield* SessionNs.Service
      const stored = yield* ssn.messages({ sessionID: session.id })
      const failed = stored.find((m) => m.info.id === assistant.id)
      expect(failed?.info.role === "assistant" && failed?.info.error).toBeDefined()
    }),
  )

  const alone = stubLLM()
  alone.push(quotaFailure(false))
  const itAlone = harness(alone.layer, { models: ["primary/flagship"] })

  itAlone.instance("a chain with nowhere left to go falls through to the old behaviour", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      const result = yield* handle.process(streamInput(user, flagship, session.id))

      expect(result).toBe("stop")
      expect(handle.message.error).toBeDefined()
    }),
  )

  const ok = stubLLM()
  ok.push(textReply("done"))
  const itOk = harness(ok.layer)

  itOk.instance("a healthy turn is untouched by any of this", () =>
    Effect.gen(function* () {
      const { session, user, assistant } = yield* seed()
      const processors = yield* SessionProcessor.Service
      const handle = yield* processors.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: flagship,
      })

      const result = yield* handle.process(streamInput(user, flagship, session.id))

      expect(result).toBe("continue")
      expect(handle.fallback).toBeUndefined()
      expect(handle.message.error).toBeUndefined()
    }),
  )
})
