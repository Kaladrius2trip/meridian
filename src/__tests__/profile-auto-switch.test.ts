import { beforeEach, describe, expect, it, mock } from "bun:test"

type QueryCall = {
  readonly callIndex: number
  readonly claudeConfigDir: string | undefined
  readonly prompt: unknown
  readonly resume: string | undefined
}

let queryCalls: QueryCall[] = []
let queryCallCount = 0
let failCalls: number[] = [1]

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: { readonly prompt?: unknown; readonly options?: { readonly env?: Record<string, string | undefined>; readonly resume?: string } }) => {
    queryCallCount += 1
    const callIndex = queryCallCount
    queryCalls.push({
      callIndex,
      claudeConfigDir: opts.options?.env?.CLAUDE_CONFIG_DIR,
      prompt: opts.prompt,
      resume: opts.options?.resume,
    })

    return (async function* () {
      if (failCalls.includes(callIndex)) {
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

const realModels = await import("../proxy/models")
mock.module("../proxy/models", () => ({
  ...realModels,
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
    failCalls = [1]
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
    expect(queryCalls.map(c => ({ callIndex: c.callIndex, claudeConfigDir: c.claudeConfigDir }))).toEqual([
      { callIndex: 1, claudeConfigDir: "/profiles/personal" },
      { callIndex: 2, claudeConfigDir: "/profiles/work" },
    ])
  })

  it("rebuilds the full-history prompt when a cached continuation switches profiles", async () => {
    failCalls = []
    const app = createTestApp()

    const first = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "first question" }],
      }),
    }))
    expect(first.status).toBe(200)
    expect(queryCalls.length).toBe(1)

    failCalls = [2]
    const second = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: "second question" },
        ],
      }),
    }))
    expect(second.status).toBe(200)
    expect(queryCalls.length).toBe(3)

    const resumeAttempt = queryCalls[1]!
    expect(resumeAttempt.resume).toBeDefined()
    expect(String(resumeAttempt.prompt)).not.toContain("first question")

    const retry = queryCalls[2]!
    expect(retry.claudeConfigDir).toBe("/profiles/work")
    expect(retry.resume).toBeUndefined()
    expect(String(retry.prompt)).toContain("first question")
    expect(String(retry.prompt)).toContain("second question")
  })
})
