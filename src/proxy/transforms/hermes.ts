import type { RequestContext, Transform } from "../transform"
import { stripHermesBoilerplate } from "./promptScrub"

export const hermesTransforms: Transform[] = [
  {
    name: "hermes-core",
    adapters: ["hermes"],

    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: [],
        incompatibleTools: [],
        allowedMcpTools: [],
        sdkAgents: {},
        sdkHooks: undefined,
        passthrough: true,
        systemContext: stripHermesBoilerplate(ctx.systemContext),
        supportsThinking: true,
        shouldTrackFileChanges: false,
      }
    },
  },
]
