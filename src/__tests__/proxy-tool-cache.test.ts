/**
 * Tests for session tool caching — when a client drops tools on a
 * continuation request, Meridian reuses the last-seen tool set to
 * preserve prompt cache stability.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { assistantMessage, makeRequest } from "./helpers"

type CapturedQueryParams = {
  readonly options?: {
    readonly env?: Record<string, string | undefined>
    readonly mcpServers?: Record<string, unknown>
  }
}

let capturedQueryParamsHistory: CapturedQueryParams[] = []
let mockMessages: Array<ReturnType<typeof assistantMessage>> = []
let rateLimitOnceDirs = new Set<string>()
let consumedRateLimitDirs = new Set<string>()

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: CapturedQueryParams) => {
    capturedQueryParamsHistory.push(params)
    return (async function* () {
      const configDir = params.options?.env?.CLAUDE_CONFIG_DIR
      if (configDir !== undefined && rateLimitOnceDirs.has(configDir) && !consumedRateLimitDirs.has(configDir)) {
        consumedRateLimitDirs.add(configDir)
        throw new Error("Claude Code returned an error result: You've hit your session limit · resets 7:57pm")
      }
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type TestApp = ReturnType<typeof createProxyServer>["app"]

const SESSION_ID = "tool-cache-test-session"

const TOOL_A = {
  name: "read_file",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

const TOOL_B = {
  name: "write_file",
  description: "Write a file",
  input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
}

function createTestApp(profileIds: string[] = []) {
  const profiles = profileIds.map((id) => ({ id, claudeConfigDir: `/profiles/${id}` }))
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
  return app
}

async function post(app: TestApp, body: Record<string, unknown>, sessionId = SESSION_ID) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify(body),
  }))
}

describe("Session tool cache", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedQueryParamsHistory = []
    rateLimitOnceDirs = new Set<string>()
    consumedRateLimitDirs = new Set<string>()
    mockMessages = [
      assistantMessage([{ type: "text", text: "Done." }]),
    ]
  })

  it("caches tools from first request and reuses when client sends none", async () => {
    const app = createTestApp()

    // Request 1: client sends tools
    await post(app, makeRequest({
      stream: false,
      tools: [TOOL_A, TOOL_B],
      messages: [{ role: "user", content: "hello" }],
    }))

    // Verify tools were registered
    const opts1 = capturedQueryParamsHistory.at(-1)?.options
    expect(opts1?.mcpServers).toBeDefined()

    // Request 2: same session, no tools — should reuse cached
    await post(app, makeRequest({
      stream: false,
      tools: [],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "continue" },
      ],
    }))

    const opts2 = capturedQueryParamsHistory.at(-1)?.options
    expect(opts2?.mcpServers).toBeDefined()
  })

  it("does not reuse tools for a different session", async () => {
    const app = createTestApp()

    // Request 1: session A sends tools
    await post(app, makeRequest({
      stream: false,
      tools: [TOOL_A],
      messages: [{ role: "user", content: "hello" }],
    }), "session-a")

    // Request 2: session B sends no tools — should NOT get session A's tools
    await post(app, makeRequest({
      stream: false,
      tools: [],
      messages: [{ role: "user", content: "hello" }],
    }), "session-b")

    const opts2 = capturedQueryParamsHistory.at(-1)?.options
    // In passthrough mode without tools, mcpServers should not have the passthrough server
    const hasPassthroughMcp = opts2?.mcpServers && Object.keys(opts2.mcpServers).some(
      (k: string) => k.includes("passthrough") || k === "oc"
    )
    expect(hasPassthroughMcp).toBeFalsy()
  })

  it("updates cached tools when client sends a new set", async () => {
    const app = createTestApp()

    // Request 1: send TOOL_A
    await post(app, makeRequest({
      stream: false,
      tools: [TOOL_A],
      messages: [{ role: "user", content: "hello" }],
    }))

    // Request 2: send TOOL_A + TOOL_B (updated set)
    await post(app, makeRequest({
      stream: false,
      tools: [TOOL_A, TOOL_B],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "continue" },
      ],
    }))

    // Request 3: no tools — should get the updated set (TOOL_A + TOOL_B)
    await post(app, makeRequest({
      stream: false,
      tools: [],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "continue" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "more" },
      ],
    }))

    const opts3 = capturedQueryParamsHistory.at(-1)?.options
    expect(opts3?.mcpServers).toBeDefined()
  })

  it("does not cache tools when not in passthrough mode", async () => {
    const app = createTestApp()

    // Set passthrough off
    const originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"

    try {
      // Request with tools in non-passthrough mode
      await post(app, makeRequest({
        stream: false,
        tools: [TOOL_A],
        messages: [{ role: "user", content: "hello" }],
      }))

      // Request without tools — no cache should apply
      await post(app, makeRequest({
        stream: false,
        tools: [],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "Done." },
          { role: "user", content: "continue" },
        ],
      }))

      const opts2 = capturedQueryParamsHistory.at(-1)?.options
      const hasPassthroughMcp = opts2?.mcpServers && Object.keys(opts2.mcpServers).some(
        (k: string) => k.includes("passthrough") || k === "oc"
      )
      expect(hasPassthroughMcp).toBeFalsy()
    } finally {
      if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
      else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
    }
  })

  it("carries passthrough tool and MCP caches to a relocated profile", async () => {
    const app = createTestApp(["personal", "work"])
    rateLimitOnceDirs.add("/profiles/personal")

    const first = await post(app, makeRequest({
      stream: false,
      tools: [TOOL_A],
      messages: [{ role: "user", content: "hello" }],
    }), "S")
    const continuation = await post(app, makeRequest({
      stream: false,
      tools: [],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "continue" },
      ],
    }), "S")

    expect([first.status, continuation.status]).toEqual([200, 200])
    expect(capturedQueryParamsHistory.map((params) => params.options?.env?.CLAUDE_CONFIG_DIR)).toEqual([
      "/profiles/personal",
      "/profiles/work",
      "/profiles/work",
    ])
    const relocatedMcp = capturedQueryParamsHistory[1]?.options?.mcpServers?.oc
    const continuationMcp = capturedQueryParamsHistory[2]?.options?.mcpServers?.oc
    expect(relocatedMcp).toBeDefined()
    expect(continuationMcp).toBe(relocatedMcp)
  })
})
