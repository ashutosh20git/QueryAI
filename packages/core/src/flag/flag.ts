import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["QUERYAI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["QUERYAI_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("QUERYAI_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  QUERYAI_AUTO_HEAP_SNAPSHOT: truthy("QUERYAI_AUTO_HEAP_SNAPSHOT"),
  QUERYAI_GIT_BASH_PATH: process.env["QUERYAI_GIT_BASH_PATH"],
  QUERYAI_CONFIG: process.env["QUERYAI_CONFIG"],
  QUERYAI_CONFIG_CONTENT: process.env["QUERYAI_CONFIG_CONTENT"],
  QUERYAI_DISABLE_AUTOUPDATE: truthy("QUERYAI_DISABLE_AUTOUPDATE"),
  QUERYAI_ALWAYS_NOTIFY_UPDATE: truthy("QUERYAI_ALWAYS_NOTIFY_UPDATE"),
  QUERYAI_DISABLE_PRUNE: truthy("QUERYAI_DISABLE_PRUNE"),
  QUERYAI_DISABLE_TERMINAL_TITLE: truthy("QUERYAI_DISABLE_TERMINAL_TITLE"),
  QUERYAI_SHOW_TTFD: truthy("QUERYAI_SHOW_TTFD"),
  QUERYAI_DISABLE_AUTOCOMPACT: truthy("QUERYAI_DISABLE_AUTOCOMPACT"),
  QUERYAI_DISABLE_MODELS_FETCH: truthy("QUERYAI_DISABLE_MODELS_FETCH"),
  QUERYAI_DISABLE_MOUSE: truthy("QUERYAI_DISABLE_MOUSE"),
  QUERYAI_FAKE_VCS: process.env["QUERYAI_FAKE_VCS"],
  QUERYAI_SERVER_PASSWORD: process.env["QUERYAI_SERVER_PASSWORD"],
  QUERYAI_SERVER_USERNAME: process.env["QUERYAI_SERVER_USERNAME"],
  QUERYAI_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("QUERYAI_DISABLE_FFF"),

  // Experimental
  QUERYAI_EXPERIMENTAL_FILEWATCHER: Config.boolean("QUERYAI_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  QUERYAI_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("QUERYAI_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  QUERYAI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("QUERYAI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  QUERYAI_MODELS_URL: process.env["QUERYAI_MODELS_URL"],
  QUERYAI_MODELS_PATH: process.env["QUERYAI_MODELS_PATH"],
  QUERYAI_DB: process.env["QUERYAI_DB"],

  QUERYAI_WORKSPACE_ID: process.env["QUERYAI_WORKSPACE_ID"],
  QUERYAI_EXPERIMENTAL_WORKSPACES: enabledByExperimental("QUERYAI_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get QUERYAI_DISABLE_PROJECT_CONFIG() {
    return truthy("QUERYAI_DISABLE_PROJECT_CONFIG")
  },
  get QUERYAI_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("QUERYAI_EXPERIMENTAL_REFERENCES")
  },
  get QUERYAI_TUI_CONFIG() {
    return process.env["QUERYAI_TUI_CONFIG"]
  },
  get QUERYAI_CONFIG_DIR() {
    return process.env["QUERYAI_CONFIG_DIR"]
  },
  get QUERYAI_PURE() {
    return truthy("QUERYAI_PURE")
  },
  get QUERYAI_PERMISSION() {
    return process.env["QUERYAI_PERMISSION"]
  },
  get QUERYAI_PLUGIN_META_FILE() {
    return process.env["QUERYAI_PLUGIN_META_FILE"]
  },
  get QUERYAI_CLIENT() {
    return process.env["QUERYAI_CLIENT"] ?? "cli"
  },
}
