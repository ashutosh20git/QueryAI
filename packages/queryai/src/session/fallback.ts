import { Context, Effect, Layer } from "effect"
import { sortBy } from "remeda"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { SessionV1 } from "@queryai/core/v1/session"
import { ModelV2 } from "@queryai/core/model"
import { ProviderV2 } from "@queryai/core/provider"
import { serviceUse } from "@queryai/core/effect/service-use"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import type { SessionID } from "./schema"
import type { SessionRetry } from "./retry"

export type Candidate = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

const DEFAULT_MAX_SWITCHES = 3

/**
 * A retirement is a cooldown, not a tombstone. A plain rate limit is a window
 * that reopens in minutes; a quota ceiling is usually a daily or monthly budget,
 * so it is held for an hour before the model is offered again rather than being
 * written off for the life of the process.
 */
const SOFT_COOLDOWN_MS = 5 * 60_000
const HARD_COOLDOWN_MS = 60 * 60_000
/** Sessions untouched this long are dropped, so a server does not accumulate them. */
const SESSION_TTL_MS = 6 * 60 * 60_000

/**
 * A key that is out of quota is still out of quota in thirty seconds, so these
 * skip the retry budget entirely and go straight to another model. Soft capacity
 * errors (a plain 429 with a retry-after, a provider hiccup) are worth waiting
 * out first and only fall back once the budget is spent.
 */
const HARD_PATTERNS = [
  /quota|insufficient_quota|billing|credit balance|payment required|out of credits/i,
  /resource[-_\s]?exhausted|free.?(?:tier|usage) limit|usage limit reached|exceeded your current/i,
]

const SOFT_PATTERNS = [
  /rate[-_\s]?limit|too many requests|rate increased too quickly/i,
  /overloaded|at capacity|service unavailable|service_unavailable/i,
]

/**
 * 402 is only ever about money. 403 is deliberately absent: providers return it
 * for a revoked key, a model the account is not entitled to, and a blocked
 * region as readily as for an exhausted budget, and silently walking to another
 * provider would bury an auth failure the user has to fix. A 403 that really is
 * a quota ceiling still says so in the body, which HARD_PATTERNS catches.
 */
const HARD_STATUS = [402]
const SOFT_STATUS = [429, 503, 529]

function text(error: SessionRetry.Err) {
  if (SessionV1.APIError.isInstance(error)) {
    return [error.data.message, error.data.responseBody].filter((v) => typeof v === "string").join("\n")
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" ? message : ""
}

function status(error: SessionRetry.Err) {
  return SessionV1.APIError.isInstance(error) ? error.data.statusCode : undefined
}

/**
 * Exhaustion that another model can absorb. Deliberately narrow: a network
 * outage or a context overflow reproduces on every provider, so switching would
 * only burn a second key to reach the same failure.
 */
export function hard(error: SessionRetry.Err) {
  if (SessionV1.ContextOverflowError.isInstance(error)) return false
  const code = status(error)
  if (code !== undefined && HARD_STATUS.includes(code)) return true
  const body = text(error)
  // A free-tier ceiling is a hard stop even though the provider reports it as 429.
  if (body.includes("FreeUsageLimitError") || body.includes("GoUsageLimitError")) return true
  return HARD_PATTERNS.some((pattern) => pattern.test(body))
}

export function soft(error: SessionRetry.Err) {
  if (SessionV1.ContextOverflowError.isInstance(error)) return false
  const code = status(error)
  if (code !== undefined && SOFT_STATUS.includes(code)) return true
  return SOFT_PATTERNS.some((pattern) => pattern.test(text(error)))
}

/** Whether switching models is a plausible response to this failure at all. */
export function exhausted(error: SessionRetry.Err) {
  return hard(error) || soft(error)
}

/**
 * A model can only take over a stuck turn if it can drive the tool loop, so
 * anything without tool calling is not a fallback however capable it is.
 */
export function eligible(model: Provider.Model) {
  if (!model.capabilities.toolcall) return false
  return model.status !== "deprecated" && model.status !== "alpha"
}

/**
 * Open models are published with their parameter count in the name, which is the
 * only capability signal left once price is zero - and price is zero for most of
 * what a free-tier setup can reach. Reads the first "<n>b" in the id, so
 * "nemotron-3-ultra-550b-a55b" is 550, not 55.
 */
export function params(model: Provider.Model) {
  const match = /(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(model.id)
  return match ? Number.parseFloat(match[1]) : 0
}

export const free = (model: Provider.Model) => model.cost.output === 0

/**
 * "Level" ordered from the catalog rather than a hand-kept list of names, so a
 * model released next month ranks itself. Output price is the strongest public
 * proxy for tier, but it collapses to zero across whole providers, so parameter
 * count, context and reasoning carry the ordering from there.
 *
 * Free models come first regardless of level: a fallback is an accident the user
 * did not ask for, and it must not quietly move a session onto a metered key
 * while a zero-cost one can still take the turn.
 */
export function rank(models: Provider.Model[]) {
  return sortBy(
    models.filter(eligible),
    [(model) => (free(model) ? 0 : 1), "asc"],
    [(model) => model.cost.output, "desc"],
    [(model) => params(model), "desc"],
    [(model) => model.limit.context, "desc"],
    [(model) => (model.capabilities.reasoning ? 1 : 0), "desc"],
    [(model) => model.release_date, "desc"],
    [(model) => model.id, "asc"],
  )
}

/**
 * Quota is billed per key, so walking one provider's whole lineup after its key
 * dies just burns requests against the same dead credential. Take the best model
 * from each provider, then the second best from each, and so on - a switch always
 * lands on a different key than the one that just failed.
 */
export function interleave(models: Provider.Model[]) {
  const byProvider = new Map<string, Provider.Model[]>()
  for (const model of rank(models)) {
    const list = byProvider.get(model.providerID)
    if (list) list.push(model)
    else byProvider.set(model.providerID, [model])
  }
  // Providers take their turn in order of how good their best model is.
  const lanes = [...byProvider.values()]
  const out: Provider.Model[] = []
  for (let depth = 0; out.length < models.length; depth++) {
    let added = false
    for (const lane of lanes) {
      const model = lane[depth]
      if (!model) continue
      out.push(model)
      added = true
    }
    if (!added) break
  }
  return out
}

export const key = (candidate: Candidate) => `${candidate.providerID}/${candidate.modelID}`

export const same = (a: Candidate, b: Candidate) => a.providerID === b.providerID && a.modelID === b.modelID

export interface Interface {
  /**
   * The next model to try after `current` failed, or undefined when the chain is
   * spent, fallback is off, or the error is not one a different model can absorb.
   */
  readonly next: (input: {
    sessionID: SessionID
    current: Candidate
    error: SessionRetry.Err
  }) => Effect.Effect<Candidate | undefined>
  /**
   * Substitute a model already known to be spent in this session. Keeps later
   * turns from re-probing a key that is out of quota.
   */
  readonly resolve: (input: { sessionID: SessionID; preferred: Candidate }) => Effect.Effect<Candidate>
  /**
   * Whether this session has somewhere to go other than `current`. Answered up
   * front so the retry policy can decide synchronously whether waiting is worth
   * it; when the answer is no, the ordinary backoff is left exactly as it was.
   */
  readonly available: (input: { sessionID: SessionID; current: Candidate }) => Effect.Effect<boolean>
  readonly chain: () => Effect.Effect<Candidate[]>
  readonly reset: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@queryai/SessionFallback") {}

export const use = serviceUse(Service)

type Spent = {
  /**
   * Switches this session has actually performed. This, not the size of the maps
   * below, is what `max_switches` bounds - retirements lapse with time, and a
   * budget that healed itself would let one session thrash forever.
   */
  switches: number
  /** Individual models retired, keyed by provider/model, valued by when the retirement lapses. */
  models: Map<string, number>
  /**
   * Whole providers retired. A quota ceiling is charged against the key, not the
   * model, so every model behind that key is gone with it.
   */
  providers: Map<string, number>
  /** Last time this session asked anything, for pruning. */
  touched: number
}

type State = {
  spent: Map<SessionID, Spent>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("SessionFallback.state")(() => Effect.succeed({ spent: new Map<SessionID, Spent>() })),
    )

    const settings = Effect.fn("SessionFallback.settings")(function* () {
      const cfg = (yield* config.get()).fallback
      return {
        enabled: cfg?.enabled ?? true,
        models: cfg?.models,
        maxSwitches: cfg?.max_switches ?? DEFAULT_MAX_SWITCHES,
        maxCost: cfg?.max_cost,
      }
    })

    /**
     * An explicit list is an instruction, not a hint: it is taken in the order
     * written and nothing is appended to it. Without one the chain is every model
     * we hold a credential for, ranked by level.
     */
    const chain: Interface["chain"] = Effect.fn("SessionFallback.chain")(function* () {
      const cfg = yield* settings()
      if (cfg.models) {
        return cfg.models.flatMap((entry) => {
          const parsed = Provider.parseModel(entry)
          if (!parsed.modelID) return []
          return [{ providerID: parsed.providerID, modelID: parsed.modelID }]
        })
      }
      const providers = yield* provider.list()
      const models = Object.values(providers).flatMap((item) => Object.values(item.models))
      return interleave(models).map((model) => ({ providerID: model.providerID, modelID: model.id }))
    })

    const spentFor = Effect.fn("SessionFallback.spentFor")(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      const now = Date.now()
      // A server holds one entry per session it has ever fallen back on, so idle
      // ones are swept here rather than waiting for an explicit reset that a
      // crashed or abandoned session will never send.
      for (const [id, entry] of s.spent) {
        if (id !== sessionID && now - entry.touched > SESSION_TTL_MS) s.spent.delete(id)
      }
      let entry = s.spent.get(sessionID)
      if (!entry) {
        entry = { switches: 0, models: new Map<string, number>(), providers: new Map<string, number>(), touched: now }
        s.spent.set(sessionID, entry)
      }
      entry.touched = now
      return entry
    })

    /** Whether a retirement is still in force, dropping it once it has lapsed. */
    const held = (map: Map<string, number>, id: string) => {
      const until = map.get(id)
      if (until === undefined) return false
      if (until > Date.now()) return true
      map.delete(id)
      return false
    }

    const burned = (spent: Spent, candidate: Candidate) =>
      held(spent.providers, candidate.providerID) || held(spent.models, key(candidate))

    /** Whether the session may switch again at all. Asked identically by `next` and `available`. */
    const room = (spent: Spent, maxSwitches: number) => spent.switches < maxSwitches

    /**
     * Candidates are checked against the live catalog before being offered - an
     * explicit list may name a model whose provider has no credential, and
     * handing that back would trade one dead turn for another.
     */
    const lookup = Effect.fn("SessionFallback.lookup")(function* (candidate: Candidate) {
      return yield* provider
        .getModel(candidate.providerID, candidate.modelID)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
    })

    /**
     * The most a fallback is allowed to cost per output token. Defaults to what
     * the model that just failed costs, so a switch never upgrades the user onto
     * a pricier key behind their back - on a free model that means the session
     * stays on free models. `fallback.max_cost` overrides it in either direction.
     */
    const ceiling = Effect.fn("SessionFallback.ceiling")(function* (
      cfg: { maxCost: number | undefined },
      current: Candidate,
    ) {
      if (cfg.maxCost !== undefined) return cfg.maxCost
      return (yield* lookup(current))?.cost.output
    })

    const pick = Effect.fn("SessionFallback.pick")(function* (input: {
      sessionID: SessionID
      skip: Candidate[]
      ceiling: number | undefined
    }) {
      const cfg = yield* settings()
      if (!cfg.enabled) return undefined
      const spent = yield* spentFor(input.sessionID)

      const candidates = yield* chain()
      for (const candidate of candidates) {
        if (burned(spent, candidate)) continue
        if (input.skip.some((item) => same(item, candidate))) continue
        const model = yield* lookup(candidate)
        if (!model || !eligible(model)) continue
        // An explicit chain is an instruction the user wrote down, so the price
        // guard only polices the one we ranked ourselves.
        if (!cfg.models && input.ceiling !== undefined && model.cost.output > input.ceiling) continue
        return candidate
      }
      return undefined
    })

    const next: Interface["next"] = Effect.fn("SessionFallback.next")(function* (input) {
      if (!exhausted(input.error)) return undefined
      const cfg = yield* settings()
      if (!cfg.enabled) return undefined
      const spent = yield* spentFor(input.sessionID)
      if (!room(spent, cfg.maxSwitches)) return undefined

      const now = Date.now()
      const until = now + (hard(input.error) ? HARD_COOLDOWN_MS : SOFT_COOLDOWN_MS)
      spent.models.set(key(input.current), until)
      // A quota ceiling belongs to the key, so retiring only the model would send
      // the next attempt straight back to the same dead credential. A plain rate
      // limit is often per-model, so there only the model steps aside.
      if (hard(input.error)) spent.providers.set(input.current.providerID, until)

      const candidate = yield* pick({
        sessionID: input.sessionID,
        skip: [input.current],
        ceiling: yield* ceiling(cfg, input.current),
      })
      if (candidate) {
        spent.switches++
        yield* Effect.logInfo("session model fallback", {
          "session.id": input.sessionID,
          from: key(input.current),
          to: key(candidate),
        })
      }
      return candidate
    })

    const resolve: Interface["resolve"] = Effect.fn("SessionFallback.resolve")(function* (input) {
      const cfg = yield* settings()
      const spent = yield* spentFor(input.sessionID)
      if (!burned(spent, input.preferred)) return input.preferred
      // Substituting a model already known to be down is not a switch: it spends
      // no request and consumes no budget, it just avoids a certain failure.
      const candidate = yield* pick({
        sessionID: input.sessionID,
        skip: [input.preferred],
        ceiling: yield* ceiling(cfg, input.preferred),
      })
      return candidate ?? input.preferred
    })

    const available: Interface["available"] = Effect.fn("SessionFallback.available")(function* (input) {
      const cfg = yield* settings()
      if (!cfg.enabled) return false
      const spent = yield* spentFor(input.sessionID)
      // Asked before the turn fails, so it must answer the same question `next`
      // will: is there budget left, and somewhere to go once this model is out.
      if (!room(spent, cfg.maxSwitches)) return false
      return (
        (yield* pick({
          sessionID: input.sessionID,
          skip: [input.current],
          ceiling: yield* ceiling(cfg, input.current),
        })) !== undefined
      )
    })

    const reset: Interface["reset"] = Effect.fn("SessionFallback.reset")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      s.spent.delete(sessionID)
    })

    return Service.of({ next, resolve, available, chain, reset })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Provider.node],
})

export * as SessionFallback from "./fallback"
