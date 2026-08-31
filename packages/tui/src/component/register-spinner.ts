import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerQueryAISpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
