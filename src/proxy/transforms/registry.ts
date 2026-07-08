import type { Transform } from "../transform"
import { openCodeTransforms } from "./opencode"
import { crushTransforms } from "./crush"
import { droidTransforms } from "./droid"
import { piTransforms } from "./pi"
import { forgeCodeTransforms } from "./forgecode"
import { passthroughTransforms } from "./passthrough"
import { hermesTransforms } from "./hermes"

const ADAPTER_TRANSFORMS: Record<string, readonly Transform[]> = {
  opencode: openCodeTransforms,
  crush: crushTransforms,
  droid: droidTransforms,
  pi: piTransforms,
  forgecode: forgeCodeTransforms,
  passthrough: passthroughTransforms,
  // The OpenAI-compatible endpoint reuses OpenCode's transforms verbatim so
  // tool/passthrough behaviour is identical; only the preset default differs
  // (see sdkFeatures.ADAPTER_DEFAULTS.openai).
  openai: openCodeTransforms,
  hermes: hermesTransforms,
}

export function getAdapterTransforms(adapterName: string): readonly Transform[] {
  return ADAPTER_TRANSFORMS[adapterName] ?? []
}
