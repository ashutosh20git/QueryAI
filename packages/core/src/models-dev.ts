import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@queryai/schema/models-dev"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const USER_AGENT = `queryai/${InstallationChannel}/${InstallationVersion}/${Flag.QUERYAI_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

/**
 * Where the model catalog is fetched from. `<source>/api.json` must serve the
 * models.dev schema.
 *
 * models.dev is the catalog's home and is public to everyone, so it is what an
 * ordinary install reads and it works on a machine that has never heard of this
 * project. Point `QUERYAI_MODELS_URL` at your own host to take over completely,
 * or set `QUERYAI_DISABLE_MODELS_FETCH` to run offline from the build-time
 * snapshot.
 */
export const DEFAULT_SOURCE = "https://models.dev"

/**
 * Our own daily mirror of `DEFAULT_SOURCE`, published by
 * `.github/workflows/catalog.yml`, used only when models.dev cannot be reached -
 * an empty catalog is not a degraded CLI, it is one that cannot name a single
 * model, so it is worth a second request to avoid.
 *
 * Lives in the public distribution repo rather than beside the source, because
 * raw.githubusercontent serves a repository's branches only while that
 * repository is public and the source repo is not. Kept as the backup rather
 * than the primary so that a mirror that is ever missing costs a retry rather
 * than a doomed request on every refresh.
 */
export const MIRROR_SOURCE = "https://raw.githubusercontent.com/QueryAI-org/QueryAI/catalog"

/**
 * The shared catalog still publishes the built-in provider under its pre-rename
 * ids and env var. Alias them here, at the single boundary every consumer reads
 * from - the provider loader, `queryai auth login`, the `/provider` list, the v2
 * catalog and integration plugins - so the id a credential is stored under is
 * the id that is looked up. A catalog that already ships the QueryAI entries
 * passes through untouched.
 */
const ALIASES: Record<string, Pick<Provider, "id" | "name" | "env">> = {
  opencode: { id: "queryai", name: "QueryAI Zen", env: ["QUERYAI_API_KEY"] },
  "opencode-go": { id: "queryai-go", name: "QueryAI Go", env: ["QUERYAI_API_KEY"] },
}

/**
 * The current id for a provider id that may have been persisted before the
 * rename - a model pinned in config, a recently used model, the provider a
 * stored session ran on. Unlike `alias`, this has no catalog to defer to, so a
 * pre-rename id always resolves forward.
 */
export function aliasID(id: string): string {
  return ALIASES[id]?.id ?? id
}

export function alias(catalog: Record<string, Provider>): Record<string, Provider> {
  const result: Record<string, Provider> = {}
  for (const [id, provider] of Object.entries(catalog)) {
    const next = ALIASES[id]
    if (!next || catalog[next.id]) {
      result[id] = provider
      continue
    }
    result[next.id] = { ...provider, ...next }
  }
  return result
}

export const Event = ModelsDev.Event

declare const QUERYAI_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@queryai/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.QUERYAI_MODELS_URL || DEFAULT_SOURCE
    const filepath = path.join(
      Global.Path.cache,
      source === DEFAULT_SOURCE ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const download = (from: string) =>
      HttpClientRequest.get(`${from}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      // A configured source is an instruction - the user pointed us somewhere on
      // purpose, and quietly serving them a different catalog instead would be
      // worse than failing. Only the built-in default gets a second chance.
      if (source !== DEFAULT_SOURCE) return yield* download(source)
      return yield* download(source).pipe(
        Effect.tapError((cause) => Effect.logWarning("catalog source unavailable, trying mirror", { source, cause })),
        Effect.catch(() => download(MIRROR_SOURCE)),
      )
    })

    const loadFromDisk = fs.readJson(Flag.QUERYAI_MODELS_PATH ?? filepath).pipe(
      Effect.catch((error) => {
        if (Flag.QUERYAI_MODELS_PATH === undefined && error._tag === "FileSystemError" && error.method === "readJson") {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() => (typeof QUERYAI_MODELS_DEV === "undefined" ? undefined : QUERYAI_MODELS_DEV))

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.QUERYAI_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent queryai CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return JSON.parse(text) as Record<string, Provider>
    }).pipe(Effect.map(alias), Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
        Effect.ignore,
      )
    })

    if (!Flag.QUERYAI_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export * as ModelsDev from "./models-dev"
