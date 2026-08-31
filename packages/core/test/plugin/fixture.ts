import { AgentV2 } from "@queryai/core/agent"
import { AISDK } from "@queryai/core/aisdk"
import { Catalog } from "@queryai/core/catalog"
import { CommandV2 } from "@queryai/core/command"
import { Credential } from "@queryai/core/credential"
import { AppNodeBuilder } from "@queryai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@queryai/core/effect/app-node-platform"
import { LayerNode } from "@queryai/core/effect/layer-node"
import { EventV2 } from "@queryai/core/event"
import { FileSystem } from "@queryai/core/filesystem"
import { FSUtil } from "@queryai/core/fs-util"
import { Integration } from "@queryai/core/integration"
import { Location } from "@queryai/core/location"
import { Npm } from "@queryai/core/npm"
import { PluginV2 } from "@queryai/core/plugin"
import { Reference } from "@queryai/core/reference"
import { SkillV2 } from "@queryai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
