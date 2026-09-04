import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { logo } from "../logo"

// Editorial wordmark: the letters are spaced out and sat on a thin accent rule,
// the way the masthead is set in the design. `logo.wordmark` stays the source of
// truth for the letters so the ASCII block mark and this one cannot drift.
const WORDMARK = Array.from(logo.wordmark)

export function Logo() {
  const { theme } = useTheme()

  // One space between letters, so the rule below is drawn to the same width.
  const width = () => Math.max(0, WORDMARK.length * 2 - 1)

  return (
    <box alignItems="center" gap={0}>
      <box flexDirection="row" gap={1}>
        <For each={WORDMARK}>
          {(char) => (
            <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
              {char}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.primary} selectable={false}>
        {"─".repeat(width())}
      </text>
    </box>
  )
}
