import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["remember", "search", "list", "forget"]).annotate({
    description: "The operation to perform",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "For remember: the fact to store, as one self-contained sentence",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "For search: what to look for",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "For forget: the id of the memory to delete",
  }),
  scope: Schema.optional(Schema.Literals(["project", "user"])).annotate({
    description:
      "For remember: 'project' (default) for facts about this codebase, 'user' for facts true of the person everywhere. For list: filter to one scope.",
  }),
})

type Metadata = {
  action: string
  count?: number
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.action],
            always: [params.action],
            metadata: { action: params.action },
          })

          const result = yield* Effect.gen(function* () {
            switch (params.action) {
              case "remember": {
                const text = params.text?.trim()
                if (!text) return { title: "memory", output: "remember requires 'text'", metadata: { action: "remember" } }
                yield* memory.remember({
                  text,
                  scope: params.scope,
                  agent: ctx.agent,
                  sessionID: ctx.sessionID,
                })
                return {
                  title: `remembered (${params.scope ?? "project"})`,
                  output: `Remembered: ${text}`,
                  metadata: { action: "remember" },
                }
              }
              case "search": {
                const query = params.query?.trim()
                if (!query) return { title: "memory", output: "search requires 'query'", metadata: { action: "search" } }
                const items = yield* memory.search({ query, agent: ctx.agent })
                return {
                  title: `${items.length} memories`,
                  output: items.length === 0 ? "No matching memories." : format(items),
                  metadata: { action: "search", count: items.length },
                }
              }
              case "list": {
                const items = yield* memory.list({ scope: params.scope })
                return {
                  title: `${items.length} memories`,
                  output: items.length === 0 ? "No memories stored." : format(items),
                  metadata: { action: "list", count: items.length },
                }
              }
              case "forget": {
                const id = params.id?.trim()
                if (!id) return { title: "memory", output: "forget requires 'id'", metadata: { action: "forget" } }
                yield* memory.forget(id)
                return { title: "forgot", output: `Deleted memory ${id}`, metadata: { action: "forget" } }
              }
            }
          }).pipe(
            // A memory backend that is down or misconfigured should read as a failed
            // tool call the model can react to, not as a crashed session.
            Effect.catch((error) =>
              Effect.succeed({
                title: "memory unavailable",
                output: error instanceof Error ? error.message : String(error),
                metadata: { action: params.action },
              }),
            ),
          )

          yield* ctx.metadata({ title: result.title, metadata: result.metadata })
          return result
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function format(items: Memory.Info[]) {
  return items.map((item) => `- [${item.id}] (${item.scope}) ${item.text}`).join("\n")
}
