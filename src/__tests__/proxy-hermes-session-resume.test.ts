import { beforeEach, describe, expect, it, mock } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: Array<Record<string, unknown>> = []
let capturedQueryParams: any = null

const MOCK_SDK_SESSION = "sdk-session-abc123"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: MOCK_SDK_SESSION }
      }
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
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postChat(app: any, body: unknown, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function expectOk(response: Response): Promise<void> {
  if (response.status !== 200) throw new Error(await response.text())
}

describe("Hermes OpenAI session resume", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedQueryParams = null
    mockMessages = []
  })

  it("resumes tool-result-only continuations with the same explicit session", async () => {
    const app = createTestApp()

    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "call_skill", name: "skill_view", input: { name: "caveman" } },
      ]),
    ]

    const firstResponse = await postChat(app, {
      model: "claude-fable-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi bro who are you ?" }],
      tools: [{ type: "function", function: { name: "skill_view", parameters: {} } }],
    }, { "x-meridian-agent": "hermes", "x-opencode-session": "hermes-session-1" })
    await expectOk(firstResponse)
    await firstResponse.json()

    mockMessages = [assistantMessage([{ type: "text", text: "I am Hermes." }])]

    const secondResponse = await postChat(app, {
      model: "claude-fable-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "tool", tool_call_id: "call_skill", content: "Caveman skill loaded." },
      ],
      tools: [{ type: "function", function: { name: "skill_view", parameters: {} } }],
    }, { "x-meridian-agent": "hermes", "x-opencode-session": "hermes-session-1" })
    await expectOk(secondResponse)
    await secondResponse.json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    expect(capturedQueryParams.prompt).toContain("Caveman skill loaded.")
  })
})
