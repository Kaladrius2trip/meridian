/**
 * Meridian OpenCode plugin.
 *
 * Injects headers into every Anthropic API request so the proxy can:
 *   1. Track sessions reliably (x-opencode-session / x-opencode-request)
 *   2. Select the right model tier per agent (x-opencode-agent-mode)
 *      — primary agents get sonnet[1m] / opus[1m] (full 1M context)
 *      — subagents get sonnet / opus (200k, preserves rate-limit budget)
 *
 * Install once globally:
 *   meridian setup
 *
 * Or manually add to ~/.config/opencode/opencode.json:
 *   { "plugin": ["/absolute/path/to/plugin/meridian.ts"] }
 */

import { resolveRootSessionId } from "./rootSession"

type PluginInput = {
  client: {
    session: {
      get: (input: {
        path: { id: string }
        query: { directory: string }
      }) => Promise<{ data: { parentID?: string } }>
    }
  }
  directory: string
}

type Plugin = (input: PluginInput) => Promise<{
  "chat.headers"?: (
    input: {
      sessionID: string
      // Typed as string in the SDK types but is actually the full agent
      // object at runtime: { name: string; mode: "primary" | "subagent" | "all" }
      agent: string | { name?: string; mode?: string }
      model: { providerID: string }
      message: { id: string }
    },
    output: { headers: Record<string, string> }
  ) => Promise<void>
}>

const rootSessionCache = new Map<string, string>()

const MeridianPlugin: Plugin = async ({ client, directory }) => {
  return {
    "chat.headers": async (incoming, output) => {
      // Only inject headers for Anthropic provider requests
      if (incoming.model.providerID !== "anthropic") return

      // Session tracking
      output.headers["x-opencode-session"] = incoming.sessionID
      let rootSessionId = incoming.sessionID
      try {
        rootSessionId = await resolveRootSessionId(
          async (id) => {
            const response = await client.session.get({ path: { id }, query: { directory } })
            return { parentID: response.data.parentID }
          },
          incoming.sessionID,
          rootSessionCache
        )
      } catch {
        rootSessionId = incoming.sessionID
      }
      output.headers["x-opencode-root-session"] = rootSessionId
      output.headers["x-opencode-request"] = incoming.message.id

      // Agent mode — runtime value is the full agent object even though
      // the TypeScript type says string. Read .mode directly.
      const agent = incoming.agent as { name?: string; mode?: string } | string
      output.headers["x-opencode-agent-mode"] = typeof agent === "object"
        ? (agent.mode ?? "primary")
        : "primary"
      const rawName = typeof agent === "object"
        ? (agent.name ?? "unknown")
        : String(agent)
      // Strip non-ASCII characters (e.g. zero-width spaces) that cause
      // "Header has invalid value" errors in Node.js / undici.
      output.headers["x-opencode-agent-name"] = rawName.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
    },
  }
}

export default MeridianPlugin
