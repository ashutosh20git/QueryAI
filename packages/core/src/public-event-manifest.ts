export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@queryai/schema/event"
import { EventManifest } from "@queryai/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
