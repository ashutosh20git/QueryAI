import { registerCustomTheme } from "@pierre/diffs"
import { QueryAITheme } from "./marked-theme"

let registered = false

export function registerQueryAITheme() {
  if (registered) return
  registered = true
  registerCustomTheme("QueryAI", () => Promise.resolve(QueryAITheme))
}
