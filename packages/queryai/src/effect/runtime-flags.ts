import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("QUERYAI_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@queryai/RuntimeFlags", {
  autoShare: bool("QUERYAI_AUTO_SHARE"),
  pure: bool("QUERYAI_PURE"),
  disableDefaultPlugins: bool("QUERYAI_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("QUERYAI_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("QUERYAI_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("QUERYAI_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("QUERYAI_DISABLE_CLAUDE_CODE"),
    direct: bool("QUERYAI_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("QUERYAI_DISABLE_CLAUDE_CODE"),
    direct: bool("QUERYAI_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("QUERYAI_ENABLE_EXA"),
    legacy: bool("QUERYAI_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("QUERYAI_ENABLE_PARALLEL"),
    legacy: bool("QUERYAI_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("QUERYAI_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("QUERYAI_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("QUERYAI_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("QUERYAI_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("QUERYAI_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("QUERYAI_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("QUERYAI_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("QUERYAI_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("QUERYAI_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("QUERYAI_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("QUERYAI_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("QUERYAI_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("QUERYAI_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("QUERYAI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("QUERYAI_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("QUERYAI_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("QUERYAI_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@queryai/core/effect/layer-node"
