import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const MCP_SERVER_NAME = "hermes"

export const hermesAdapter: AgentAdapter = {
  name: "hermes",

  getSessionId(c: Context): string | undefined {
    return c.req.header("x-opencode-session") ?? c.req.header("x-session-affinity")
  },

  extractWorkingDirectory(_body: unknown): undefined {
    return undefined
  },

  normalizeContent(content: unknown): string {
    return normalizeContent(content)
  },

  getBlockedBuiltinTools(): readonly string[] {
    return []
  },

  getAgentIncompatibleTools(): readonly string[] {
    return []
  },

  getMcpServerName(): string {
    return MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return []
  },

  buildSdkAgents(_body: unknown, _mcpToolNames: readonly string[]): Record<string, never> {
    return {}
  },

  buildSdkHooks(_body: unknown, _sdkAgents: Record<string, unknown>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: unknown, _sdkAgents: Record<string, unknown>): string {
    return ""
  },

  usesPassthrough(): boolean {
    return true
  },

  supportsThinking(): boolean {
    return true
  },

  shouldTrackFileChanges(): boolean {
    return false
  },
}
