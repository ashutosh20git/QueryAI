import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { FSUtil } from "@queryai/core/fs-util"
import { LocalMemory } from "@/memory/local"
import { testEffect } from "../lib/effect"

const USER = "local:test-user"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const client = Effect.fn("LocalMemoryTest.client")(function* () {
  const fs = yield* FSUtil.Service
  return LocalMemory.make({ userID: USER, fs })
})

const add = (text: string, over: { agent?: string; session?: string } = {}) => ({
  messages: [{ role: "user" as const, content: text }],
  scope: {
    userID: USER,
    ...(over.agent ? { agentID: over.agent } : {}),
    ...(over.session ? { runID: over.session } : {}),
  },
})

afterEach(async () => {
  await rm(LocalMemory.file(USER), { force: true })
})

describe("memory.local scoring", () => {
  const row = (text: string, created = 0): LocalMemory.Row => ({ id: text, text, created })

  test("a rare shared term outranks a common one", () => {
    const rows = [row("the project uses pnpm"), row("the project uses typescript"), row("the project uses biome")]
    const weights = LocalMemory.idf(rows)
    const query = LocalMemory.tokenize("does the project use pnpm")
    // "project" is in every row and carries almost nothing; "pnpm" decides it.
    expect(LocalMemory.score(query, rows[0], weights)).toBeGreaterThan(LocalMemory.score(query, rows[1], weights))
  })

  test("a query sharing nothing scores zero rather than something small", () => {
    const rows = [row("prefers pnpm")]
    expect(LocalMemory.score(LocalMemory.tokenize("deployment pipeline"), rows[0], LocalMemory.idf(rows))).toBe(0)
  })

  test("auto-capture keeps the user's words and drops the agent's", () => {
    expect(
      LocalMemory.extract([
        { role: "user", content: " we use pnpm here " },
        { role: "assistant", content: "Understood, I will use pnpm." },
      ]),
    ).toBe("we use pnpm here")
  })
})

describe("memory.local store", () => {
  it.effect("writes survive a fresh client, which is the whole point", () =>
    Effect.gen(function* () {
      const first = yield* client()
      yield* first.add(add("prefers pnpm"))

      // A new client reads the same file: this is what "persistent" means here.
      const second = yield* client()
      const items = yield* second.list({ scope: { userID: USER } })
      expect(items.map((item) => item.memory)).toEqual(["prefers pnpm"])
      expect(items[0].created_at).toBeString()
    }),
  )

  it.effect("the same fact twice stays one row", () =>
    Effect.gen(function* () {
      const store = yield* client()
      yield* store.add(add("prefers pnpm"))
      yield* store.add(add("prefers pnpm"))
      expect(yield* store.list({ scope: { userID: USER } })).toHaveLength(1)
    }),
  )

  it.effect("search ranks by overlap and forget removes by id", () =>
    Effect.gen(function* () {
      const store = yield* client()
      yield* store.add(add("prefers pnpm over npm"))
      yield* store.add(add("deploys with terraform"))

      const found = yield* store.search({ query: "which package manager, npm?", scope: { userID: USER } })
      expect(found.map((item) => item.memory)).toEqual(["prefers pnpm over npm"])

      yield* store.remove(found[0].id)
      expect(yield* store.search({ query: "npm", scope: { userID: USER } })).toHaveLength(0)
      // Deleting one row leaves the others alone.
      expect(yield* store.list({ scope: { userID: USER } })).toHaveLength(1)
    }),
  )

  it.effect("a corrupt store reads as empty instead of taking the turn down", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(LocalMemory.file(USER), "{ not json")
      const store = yield* client()
      expect(yield* store.list({ scope: { userID: USER } })).toHaveLength(0)

      // And the next write repairs it rather than failing forever.
      yield* store.add(add("prefers pnpm"))
      expect(yield* store.list({ scope: { userID: USER } })).toHaveLength(1)
    }),
  )

  it.effect("an agent only sees its own rows and the unattributed ones", () =>
    Effect.gen(function* () {
      const store = yield* client()
      yield* store.add(add("plan agent fact", { agent: "plan" }))
      yield* store.add(add("shared fact"))

      const found = yield* store.search({ query: "fact", scope: { userID: USER, agentID: "build" } })
      expect(found.map((item) => item.memory)).toEqual(["shared fact"])
    }),
  )
})
