import { run as runTui, type TuiInput } from "@queryai/tui"
import { Global } from "@queryai/core/global"
import { AppNodeBuilder } from "@queryai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
