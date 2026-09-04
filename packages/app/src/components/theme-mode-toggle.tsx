import { useTheme } from "@queryai/ui/theme/context"
import { Icon as IconV2 } from "@queryai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import "./theme-mode-toggle.css"

/**
 * Light/dark switch for the masthead.
 *
 * Flipping it pins an explicit scheme; "system" stays reachable from settings
 * and the command palette, and shows here as whichever mode it resolved to.
 */
export function ThemeModeToggle() {
  const theme = useTheme()
  const language = useLanguage()

  const dark = () => theme.mode() === "dark"
  const next = () => language.t(dark() ? "theme.scheme.light" : "theme.scheme.dark")
  const action = () => language.t("command.theme.scheme.set", { scheme: next() })

  return (
    <button
      type="button"
      data-component="theme-mode-toggle"
      role="switch"
      aria-checked={dark()}
      aria-label={action()}
      title={action()}
      onClick={() => theme.setColorScheme(dark() ? "light" : "dark")}
    >
      <span data-slot="theme-mode-toggle-track" aria-hidden="true">
        <span data-slot="theme-mode-toggle-thumb" />
        <span data-slot="theme-mode-toggle-icon" data-mode="light">
          <IconV2 name="sun" size="small" />
        </span>
        <span data-slot="theme-mode-toggle-icon" data-mode="dark">
          <IconV2 name="moon" size="small" />
        </span>
      </span>
    </button>
  )
}
