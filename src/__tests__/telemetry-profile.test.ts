/**
 * Integration test: the resolved profile id is recorded into telemetry metrics.
 *
 * Posts through the HTTP layer with a mocked SDK, then reads /telemetry/requests
 * back and asserts the metric carries the profile id chosen by the
 * x-meridian-profile header.
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { mock } from "bun:test"

// Mock the SDK before importing server
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      yield {
        type: "assistant",
        message: { type: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: `session-${Date.now()}`,
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

// Pass through the real resolveSdkModelDefaults — mock.module is process-global
// in Bun, and stubbing it as () => ({}) leaks to proxy-env-stripping.test.ts.
import { resolveSdkModelDefaults } from "../proxy/models"

// Mock models to avoid real auth checks
const realModels = await import("../proxy/models")
mock.module("../proxy/models", () => ({
  ...realModels,
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { clearSessionCache } = await import("../proxy/session/cache")
const { telemetryStore } = await import("../telemetry")

beforeEach(() => {
  resetActiveProfile()
  clearSessionCache()
  telemetryStore.clear()
})

function createTestApp(profiles?: Array<{ id: string; claudeConfigDir?: string }>) {
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: profiles as any,
  })
  return app
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init)
}

describe("Telemetry profile id", () => {
  const profiles = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("records resolved profile id from x-meridian-profile header", async () => {
    const app = createTestApp(profiles)

    const res = await app.fetch(req("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "dummy",
        "x-meridian-profile": "work",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
        stream: false,
      }),
    }))
    expect(res.status).toBe(200)

    const tRes = await app.fetch(req("/telemetry/requests"))
    expect(tRes.status).toBe(200)
    const body = await tRes.json() as Array<{ profileId?: string }>
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]!.profileId).toBe("work")
  })
})
