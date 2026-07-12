import type { RequestContext, Transform } from "../transform"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"
import { stripHermesBoilerplate } from "./promptScrub"

export const hermesTransforms: Transform[] = [
  {
    name: "hermes-core",
    adapters: ["hermes"],

    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
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
