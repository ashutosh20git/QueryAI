#!/usr/bin/env bun
/**
 * Emits the JSON Schema for `queryai.json` from the config schema itself, so the
 * file editors validate against can never drift from the one the program reads.
 *
 *   bun run --cwd packages/core script/schema.ts            # to stdout
 *   bun run --cwd packages/core script/schema.ts out.json   # to a file
 *
 * Published to the `schema` branch by .github/workflows/schema.yml and served
 * from raw.githubusercontent, which is why config examples can carry a $schema
 * that belongs to this project rather than to the one it was forked from.
 */
import { Schema } from "effect"
import { ConfigV1 } from "../src/v1/config/config"

const document = Schema.toJsonSchemaDocument(ConfigV1.Info, { additionalProperties: true })

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "QueryAI config",
  description: "Configuration for QueryAI (queryai.json / queryai.jsonc).",
  ...document.schema,
  ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
}

const text = JSON.stringify(schema, null, 2) + "\n"
const out = process.argv[2]
if (out) {
  await Bun.write(out, text)
  console.error(`wrote ${out} (${text.length} bytes)`)
} else {
  process.stdout.write(text)
}
