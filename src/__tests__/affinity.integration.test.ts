import { beforeEach, describe, expect, it, mock } from "bun:test"

type QueryOptions = {
  readonly options?: {
    readonly env?: Record<string, string | undefined>
  }
}

let claudeConfigDirs: Array<string | undefined> = []
let queryCallCount = 0
let rateLimitOnceDirs = new Set<string>()
let consumedRateLimitDirs = new Set<string>()

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: QueryOptions) => {
    queryCallCount += 1
    const configDir = opts.options?.env?.CLAUDE_CONFIG_DIR
    claudeConfigDirs.push(configDir)

    if (configDir !== undefined && rateLimitOnceDirs.has(configDir) && !consumedRateLimitDirs.has(configDir)) {
      consumedRateLimitDirs.add(configDir)
      return (async function* () {
        throw new Error("Claude Code returned an error result: You've hit your session limit · resets 7:57pm")
      })()
    }

    return (async function* () {
      yield {
        type: "assistant",
        uuid: `uuid-${queryCallCount}`,
        message: {
          id: `msg-${queryCallCount}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-session-${queryCallCount}`,
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

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

type TestApp = ReturnType<typeof createProxyServer>["app"]

function createTestApp(profileIds: string[], defaultProfile?: string): TestApp {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: profileIds.map((id) => ({ id, claudeConfigDir: `/profiles/${id}` })),
    defaultProfile,
  }).app
}

function postMessage(app: TestApp, headers: Record<string, string>, content: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content }],
    }),
  })))
}

describe("Session profile affinity", () => {
  beforeEach(() => {
    resetActiveProfile()
    clearSessionCache()
    claudeConfigDirs = []
    queryCallCount = 0
    rateLimitOnceDirs = new Set<string>()
    consumedRateLimitDirs = new Set<string>()
  })

  it("keeps one root on its profile and spreads a new root", async () => {
    const app = createTestApp(["personal", "work"])

    const first = await postMessage(app, {
      "x-opencode-root-session": "R1",
      "x-opencode-session": "R1-main",
    }, "root one")
    const child = await postMessage(app, {
      "x-opencode-root-session": "R1",
      "x-opencode-session": "R1-child",
    }, "root one child")
    const secondRoot = await postMessage(app, {
      "x-opencode-root-session": "R2",
      "x-opencode-session": "R2-main",
    }, "root two")

    expect([first.status, child.status, secondRoot.status]).toEqual([200, 200, 200])
    expect(claudeConfigDirs).toEqual([
      "/profiles/personal",
      "/profiles/personal",
      "/profiles/work",
    ])
  })

  it("honors an explicit profile without creating or overwriting affinity", async () => {
    const app = createTestApp(["personal", "work", "third"])

    await postMessage(app, { "x-opencode-root-session": "mapped-root" }, "map root")
    await postMessage(app, {
      "x-opencode-root-session": "mapped-root",
      "x-meridian-profile": "third",
    }, "override mapped root")
    await postMessage(app, { "x-opencode-root-session": "mapped-root" }, "reuse mapping")
    await postMessage(app, {
      "x-opencode-root-session": "explicit-only-root",
      "x-meridian-profile": "third",
    }, "explicit only")
    await postMessage(app, { "x-opencode-root-session": "explicit-only-root" }, "assign after explicit")

    expect(claudeConfigDirs).toEqual([
      "/profiles/personal",
      "/profiles/third",
      "/profiles/personal",
      "/profiles/third",
      "/profiles/work",
    ])
  })

  it("uses existing default behavior when no root header is present", async () => {
    const app = createTestApp(["personal", "work"], "work")

    const withoutRoot = await postMessage(app, {}, "standalone")
    const firstRoot = await postMessage(app, { "x-opencode-root-session": "R1" }, "first root")

    expect([withoutRoot.status, firstRoot.status]).toEqual([200, 200])
    expect(claudeConfigDirs).toEqual(["/profiles/work", "/profiles/personal"])
  })

  it("relocates a rate-limited root's whole tree, sticky, without moving other roots", async () => {
    const app = createTestApp(["personal", "work"])
    rateLimitOnceDirs.add("/profiles/personal")

    const moved = await postMessage(app, { "x-opencode-root-session": "MOVE" }, "root move")
    const movedAgain = await postMessage(app, { "x-opencode-root-session": "MOVE" }, "root move again")
    const kept = await postMessage(app, { "x-opencode-root-session": "KEEP" }, "root keep")

    expect([moved.status, movedAgain.status, kept.status]).toEqual([200, 200, 200])
    expect(claudeConfigDirs).toEqual([
      "/profiles/personal",
      "/profiles/work",
      "/profiles/work",
      "/profiles/personal",
    ])
  })
})
