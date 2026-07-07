import { beforeEach, describe, expect, it, mock } from "bun:test"

type QueryCall = {
  readonly callIndex: number
  readonly claudeConfigDir: string | undefined
}

let queryCalls: QueryCall[] = []
let queryCallCount = 0

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: { readonly options?: { readonly env?: Record<string, string | undefined> } }) => {
    queryCallCount += 1
    const callIndex = queryCallCount
    queryCalls.push({
      callIndex,
      claudeConfigDir: opts.options?.env?.CLAUDE_CONFIG_DIR,
    })

    return (async function* () {
      if (callIndex === 1) {
        throw new Error("429 Too Many Requests - rate limit exceeded")
      }

      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-session-${callIndex}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { resolveSdkModelDefaults } from "../proxy/models"

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  hasExtendedContext: () => false,
  stripExtendedContext: (model: string) => model,
  isClosedControllerError: () => false,
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

function createTestApp() {
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [
      { id: "personal", claudeConfigDir: "/profiles/personal" },
      { id: "work", claudeConfigDir: "/profiles/work" },
    ],
  })
  return app
}

describe("Profile auto-switch", () => {
  beforeEach(() => {
    resetActiveProfile()
    clearSessionCache()
    queryCalls = []
    queryCallCount = 0
  })

  it("retries a rate-limited active profile on the next Claude Max profile", async () => {
    const app = createTestApp()

    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))

    expect(response.status).toBe(200)
    expect(queryCalls).toEqual([
      { callIndex: 1, claudeConfigDir: "/profiles/personal" },
      { callIndex: 2, claudeConfigDir: "/profiles/work" },
    ])
  })
})
