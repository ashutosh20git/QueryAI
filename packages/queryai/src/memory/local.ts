import path from "path"
import { randomBytes } from "crypto"
import { Effect, Schema } from "effect"
import { Global } from "@queryai/core/global"
import { FSUtil } from "@queryai/core/fs-util"
import { Mem0 } from "./mem0"

/**
 * Memory that costs nothing and needs nobody: one JSON file per user under the
 * app's data directory, searched in process. It is the default backend because a
 * memory layer that only works with a paid account is not a memory layer for
 * most of the people running this - and because the alternative to "no server"
 * is not "no memory", it is "the memory lives on the machine that already runs
 * the agent".
 *
 * The trade against mem0 is deliberate and worth saying out loud: no LLM
 * extraction, no embeddings, no cross-device sync. Facts are stored as written
 * and found by term overlap. That is enough for what memory is used for here -
 * short, self-contained statements the agent wrote on purpose - and it never
 * costs a token or a round trip.
 */

const DIR = "memory"
/** A guard against a runaway auto-capture filling a disk, not a product limit. */
export const MAX_ITEMS = 5_000

const Row = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  created: Schema.Number,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  agent: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
})
export type Row = Schema.Schema.Type<typeof Row>

const File = Schema.Struct({
  version: Schema.Number,
  items: Schema.Array(Row),
})

const decode = Schema.decodeUnknownOption(File)

/** Ids are handed to the model and back through `forget`, so they stay short and opaque. */
export function id() {
  return `mem_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`
}

/** Written per user id, so two accounts on one machine never read each other's rows. */
export function file(userID: string) {
  return path.join(Global.Path.data, DIR, `${userID.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`)
}

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "how", "i", "in", "is", "it", "its",
  "me", "my", "not", "of", "on", "or", "our", "so", "that", "the", "their", "them", "then", "there", "they", "this",
  "to", "up", "use", "was", "we", "what", "when", "which", "who", "why", "will", "with", "you", "your",
])

export function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !STOP.has(term))
}

/**
 * Overlap scaled by how rare each matched term is across the store, so "pnpm"
 * counts for more than "project". No embeddings, but it puts the row a person
 * would have picked at the top for the short factual text this stores.
 */
export function score(query: string[], row: Row, idf: Map<string, number>) {
  if (query.length === 0) return 0
  const terms = new Set(tokenize(row.text))
  let hit = 0
  for (const term of query) {
    if (!terms.has(term)) continue
    hit += idf.get(term) ?? 1
  }
  if (hit === 0) return 0
  const total = query.reduce((sum, term) => sum + (idf.get(term) ?? 1), 0)
  return total === 0 ? 0 : hit / total
}

export function idf(rows: Row[]) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const term of new Set(tokenize(row.text))) counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  const out = new Map<string, number>()
  for (const [term, count] of counts) out.set(term, Math.log(1 + rows.length / count))
  return out
}

/** Everything a stored row needs to look like a mem0 row to the rest of the service. */
export function toItem(row: Row, score?: number): Mem0.Item {
  return {
    id: row.id,
    memory: row.text,
    metadata: row.metadata ?? {},
    created_at: new Date(row.created).toISOString(),
    ...(score === undefined ? {} : { score }),
  }
}

/**
 * Auto-capture hands over whole turns, and without an extraction model the
 * honest thing to store is the user's own words rather than a guess at the fact
 * behind them. Assistant text is dropped: it is the agent's output, not
 * something learned about the user.
 */
export function extract(messages: Mem0.Message[]) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, 2_000)
}

export function make(input: { userID: string; fs: FSUtil.Interface }): Mem0.Client {
  const target = file(input.userID)

  const fail = (operation: string) => (cause: unknown) =>
    new Mem0.Mem0Error({ operation, message: `local memory ${operation} failed`, cause })

  const read = Effect.fn("LocalMemory.read")(function* () {
    const raw = yield* input.fs.readJson(target).pipe(Effect.orElseSucceed(() => undefined))
    if (raw === undefined) return [] as Row[]
    const parsed = decode(raw)
    // A corrupt or hand-edited file must not take the session down with it; an
    // unreadable store reads as an empty one and is rewritten on the next write.
    if (parsed._tag === "None") return [] as Row[]
    return [...parsed.value.items]
  })

  const write = Effect.fn("LocalMemory.write")(function* (rows: Row[]) {
    const items = rows.slice(-MAX_ITEMS)
    // First write of a fresh install creates the directory as it goes; nothing
    // else in the app owns this path.
    yield* input.fs
      .writeWithDirs(target, JSON.stringify({ version: 1, items }, null, 2), 0o600)
      .pipe(Effect.mapError(fail("write")))
  })

  return {
    add: Effect.fn("LocalMemory.add")(function* (params) {
      const text = extract(params.messages)
      if (!text) return { results: [] }
      const rows = yield* read()
      const row: Row = {
        id: id(),
        text,
        created: Date.now(),
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(params.scope.agentID ? { agent: params.scope.agentID } : {}),
        ...(params.scope.runID ? { session: params.scope.runID } : {}),
      }
      // The same fact arriving twice - a repeated instruction, a re-run turn -
      // should not double up in a store that has no dedup pass of its own.
      const next = rows.filter((item) => item.text !== row.text)
      next.push(row)
      yield* write(next)
      return { results: [{ id: row.id, event: "ADD", data: { memory: row.text } }] }
    }),

    search: Effect.fn("LocalMemory.search")(function* (params) {
      const rows = yield* read()
      const scoped = rows.filter((row) => !params.scope.agentID || !row.agent || row.agent === params.scope.agentID)
      const terms = tokenize(params.query)
      const weights = idf(scoped)
      const scored = scoped
        .map((row) => ({ row, value: score(terms, row, weights) }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value || b.row.created - a.row.created)
      return scored.slice(0, params.limit ?? 10).map((entry) => toItem(entry.row, entry.value))
    }),

    list: Effect.fn("LocalMemory.list")(function* (params) {
      const rows = yield* read()
      return rows
        .slice()
        .sort((a, b) => b.created - a.created)
        .slice(0, params.limit ?? 100)
        .map((row) => toItem(row))
    }),

    remove: Effect.fn("LocalMemory.remove")(function* (id) {
      const rows = yield* read()
      const next = rows.filter((row) => row.id !== id)
      if (next.length === rows.length) return
      yield* write(next)
    }),
  }
}

export * as LocalMemory from "./local"
