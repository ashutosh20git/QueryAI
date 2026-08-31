import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.QUERYAI_CHANNEL ?? "dev"}`

await $`cd ../queryai && bun script/build-node.ts`
await downloadCliToResources()
