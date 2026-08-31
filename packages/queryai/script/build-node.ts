#!/usr/bin/env bun

import { Script } from "@queryai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    QUERYAI_MODELS_DEV: generated.modelsData,
    QUERYAI_VERSION: `'${Script.version}'`,
    QUERYAI_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "queryai-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
