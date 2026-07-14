import { beforeEach, describe, expect, it, mock } from "bun:test"
import {
  enableQueryGating,
  enterGatedCall,
  releaseCall,
  resetQueryGating,
  waitForActiveCalls,
} from "./affinity-query-gate"

type QueryOptions = {
  readonly options?: {
    readonly env?: Record<string, string | undefined>
  }
}

let claudeConfigDirs: Array<string | undefined> = []
let queryCallCount = 0
let rateLimitOnceDirs = new Set<string>()
let consumedRateLimitDirs = new Set<string>()
let emitRateLimitInfo = false

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: QueryOptions) => {
    queryCallCount += 1
    const callNumber = queryCallCount
    const configDir = opts.options?.env?.CLAUDE_CONFIG_DIR
    claudeConfigDirs.push(configDir)

    return (async function* () {
      const gatedOutcome = await enterGatedCall(configDir)
      if (gatedOutcome === "rate_limit") {
        throw new Error("Claude Code returned an error result: You've hit your session limit · resets 7:57pm")
      }
      if (gatedOutcome === undefined && configDir !== undefined && rateLimitOnceDirs.has(configDir) && !consumedRateLimitDirs.has(configDir)) {
        consumedRateLimitDirs.add(configDir)
        throw new Error("Claude Code returned an error result: You've hit your session limit · resets 7:57pm")
      }

      if (emitRateLimitInfo) {
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 },
          uuid: `rl-${callNumber}`,
          session_id: `sdk-session-${callNumber}`,
        }
      }

      yield {
        type: "assistant",
        uuid: `uuid-${callNumber}`,
        message: {
          id: `msg-${callNumber}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-session-${callNumber}`,
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

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

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
    emitRateLimitInfo = false
    rateLimitStore.clear()
    resetQueryGating()
  })

  it("does not record non-active-profile rate_limit_events in the active quota snapshot", async () => {
    const app = createTestApp(["personal", "work"])
    emitRateLimitInfo = true

    const onActive = await postMessage(app, { "x-opencode-root-session": "R1" }, "active root")
    expect(onActive.status).toBe(200)
    expect(claudeConfigDirs).toEqual(["/profiles/personal"])
    expect(rateLimitStore.getAll().length).toBe(1)

    rateLimitStore.clear()
    const onOther = await postMessage(app, { "x-opencode-root-session": "R2" }, "relocated root")
    expect(onOther.status).toBe(200)
    expect(claudeConfigDirs).toEqual(["/profiles/personal", "/profiles/work"])
    expect(rateLimitStore.getAll().length).toBe(0)
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

  it("routes x-session-affinity-only requests through affinity too", async () => {
    const app = createTestApp(["personal", "work"])

    const first = await postMessage(app, { "x-session-affinity": "A1" }, "affinity one")
    const repeat = await postMessage(app, { "x-session-affinity": "A1" }, "affinity one repeat")
    const second = await postMessage(app, { "x-session-affinity": "A2" }, "affinity two")

    expect([first.status, repeat.status, second.status]).toEqual([200, 200, 200])
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

  it("keeps an ABA-stale request on its original profile when the mapping returns to it", async () => {
    const app = createTestApp(["personal", "work"])
    enableQueryGating()

    const stale = postMessage(app, { "x-opencode-root-session": "R" }, "stale")
    await waitForActiveCalls(1)
    const move1 = postMessage(app, { "x-opencode-root-session": "R" }, "move one")
    await waitForActiveCalls(2)

    releaseCall(1, "rate_limit")
    await waitForActiveCalls(3)
    releaseCall(2, "ok")
    expect((await move1).status).toBe(200)

    const move2 = postMessage(app, { "x-opencode-root-session": "R" }, "move two")
    await waitForActiveCalls(4)
    releaseCall(3, "rate_limit")
    await waitForActiveCalls(5)
    releaseCall(4, "ok")
    expect((await move2).status).toBe(200)

    releaseCall(0, "rate_limit")
    await waitForActiveCalls(6)
    releaseCall(5, "ok")
    expect((await stale).status).toBe(200)
    expect([claudeConfigDirs[0], claudeConfigDirs[5]]).toEqual([
      "/profiles/personal",
      "/profiles/personal",
    ])
  })

  it("converges concurrent rate-limited requests on one relocated profile", async () => {
    const app = createTestApp(["personal", "work"])
    enableQueryGating()

    const request1 = postMessage(app, { "x-opencode-root-session": "R" }, "one")
    await waitForActiveCalls(1)
    const request2 = postMessage(app, { "x-opencode-root-session": "R" }, "two")
    const request3 = postMessage(app, { "x-opencode-root-session": "R" }, "three")
    await waitForActiveCalls(3)

    releaseCall(0, "rate_limit")
    await waitForActiveCalls(4)
    releaseCall(3, "ok")
    expect((await request1).status).toBe(200)

    releaseCall(1, "rate_limit")
    releaseCall(2, "rate_limit")
    await waitForActiveCalls(6)
    releaseCall(4, "ok")
    releaseCall(5, "ok")
    const responses = await Promise.all([request2, request3])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(claudeConfigDirs).toEqual([
      "/profiles/personal",
      "/profiles/personal",
      "/profiles/personal",
      "/profiles/work",
      "/profiles/work",
      "/profiles/work",
    ])
  })
})
