import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@queryai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~queryai/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~queryai/WorkspaceRef", {
  defaultValue: () => undefined,
})
