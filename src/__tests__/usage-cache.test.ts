import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type { FetchOAuthUsageOpts, OAuthUsageSnapshot } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"
import type { ProxyConfig } from "../proxy/types"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

const {
  __setFetchOAuthUsageOverride,
  fetchOAuthUsage,
  resetOAuthUsageCache,
} = await import("../proxy/oauthUsage")
const { createProxyServer, refreshAllProfilesUsage } = await import("../proxy/server")

type UsageProfile = {
  id: string
  isActive: boolean
  type?: string
  windows: OAuthUsageSnapshot["windows"]
  extraUsage: OAuthUsageSnapshot["extraUsage"]
  fetchedAt: number | null
  stale: boolean
  error: string | null
}

type AllUsageResponse = {
  profiles: UsageProfile[]
  activeProfile: string | null
  asOf: number
}

const PROFILES = [
  { id: "personal", claudeConfigDir: "/profiles/personal" },
] satisfies NonNullable<ProxyConfig["profiles"]>

const REFRESH_PROFILES = [
  ...PROFILES,
  { id: "api", type: "api", apiKey: "test-key" },
] satisfies NonNullable<ProxyConfig["profiles"]>

const FRESH_SNAPSHOT: OAuthUsageSnapshot = {
  windows: [{ type: "seven_day", utilization: 0.12, resetsAt: 1_800_000_000_000 }],
  extraUsage: null,
  fetchedAt: 1_750_000_000_000,
}

function credentialStore(): CredentialStore {
  return {
    async read() {
      return {
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
        },
      }
    },
    async write() {
      return true
    },
  }
}

async function seedUsage(profileId: string): Promise<OAuthUsageSnapshot> {
  const snapshot = await fetchOAuthUsage({
    force: true,
    profileId,
    store: credentialStore(),
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 42, resets_at: "2026-07-13T00:00:00Z" },
    }), { status: 200 }),
  })
  if (!snapshot) throw new Error("Expected seeded OAuth usage snapshot")
  return snapshot
}

function usageApp() {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: PROFILES,
    silent: true,
  }).app
}

function refreshApp() {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: REFRESH_PROFILES,
    silent: true,
  }).app
}

async function readAllUsage(response: Response): Promise<AllUsageResponse> {
  return await response.json() as AllUsageResponse
}

describe("usage last-known-good cache", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  afterEach(() => {
    __setFetchOAuthUsageOverride(null)
    resetOAuthUsageCache()
  })

  it("preserves a profile's last-known usage when a later refresh fails", async () => {
    const seeded = await seedUsage("personal")
    let calls = 0
    __setFetchOAuthUsageOverride(async () => {
      calls++
      return calls === 1 ? seeded : null
    })
    const app = usageApp()

    await app.fetch(new Request("http://localhost/v1/usage/quota/all"))
    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/all"))
    const body = await readAllUsage(response)

    expect(response.status).toBe(200)
    expect(body.profiles[0]?.windows).toEqual(seeded.windows)
    expect(body.profiles[0]?.stale).toBe(true)
    expect(body.profiles[0]?.fetchedAt).toBe(seeded.fetchedAt)
    expect(body.profiles[0]?.windows).not.toEqual([])
  })

  it("returns an empty non-stale response when a profile has never had usage data", async () => {
    __setFetchOAuthUsageOverride(async () => null)
    const app = usageApp()

    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/all"))
    const body = await readAllUsage(response)

    expect(response.status).toBe(200)
    expect(body.profiles[0]?.windows).toEqual([])
    expect(body.profiles[0]?.error).toBe("no_token")
    expect(body.profiles[0]?.stale).toBe(false)
  })
})

describe("POST /v1/usage/quota/refresh", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  afterEach(() => {
    __setFetchOAuthUsageOverride(null)
    resetOAuthUsageCache()
  })

  it("force-refreshes every Claude Max profile and returns the full profile list", async () => {
    const calls: FetchOAuthUsageOpts[] = []
    __setFetchOAuthUsageOverride(async (opts) => {
      calls.push(opts ?? {})
      return opts?.profileId === "personal" ? FRESH_SNAPSHOT : null
    })
    const app = refreshApp()

    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/refresh?profile=all", {
      method: "POST",
    }))
    const body = await readAllUsage(response)

    expect(response.status).toBe(200)
    expect(body.profiles[0]).toMatchObject({
      id: "personal",
      windows: FRESH_SNAPSHOT.windows,
      fetchedAt: FRESH_SNAPSHOT.fetchedAt,
      stale: false,
      error: null,
    })
    expect(body.profiles[1]).toMatchObject({ id: "api", stale: false, error: "not_oauth" })
    expect(calls).toEqual([{
      force: true,
      profileId: "personal",
      claudeConfigDir: "/profiles/personal",
    }])
  })

  it("returns one profile entry when a specific profile is refreshed", async () => {
    __setFetchOAuthUsageOverride(async () => FRESH_SNAPSHOT)
    const app = refreshApp()

    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/refresh?profile=personal", {
      method: "POST",
    }))
    const body = await response.json() as UsageProfile

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: "personal",
      windows: FRESH_SNAPSHOT.windows,
      stale: false,
      error: null,
    })
  })

  it("returns 404 for an unknown profile", async () => {
    __setFetchOAuthUsageOverride(async () => FRESH_SNAPSHOT)
    const app = refreshApp()

    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/refresh?profile=missing", {
      method: "POST",
    }))
    const body = await response.json() as { error: string }

    expect(response.status).toBe(404)
    expect(body.error).toBe("unknown_profile")
  })
})

describe("refreshAllProfilesUsage", () => {
  afterEach(() => {
    __setFetchOAuthUsageOverride(null)
    resetOAuthUsageCache()
  })

  it("refreshes every Claude Max profile and skips API profiles", () => {
    const calls: FetchOAuthUsageOpts[] = []
    __setFetchOAuthUsageOverride(async (opts) => {
      calls.push(opts ?? {})
      return null
    })
    const config = {
      port: 0,
      host: "127.0.0.1",
      debug: false,
      idleTimeoutSeconds: 120,
      silent: true,
      profiles: [
        { id: "personal", claudeConfigDir: "/profiles/personal" },
        { id: "work", claudeConfigDir: "/profiles/work" },
        { id: "api", type: "api", apiKey: "test-key" },
      ],
    } satisfies ProxyConfig

    refreshAllProfilesUsage(config)

    expect(calls).toEqual([
      { profileId: "personal", claudeConfigDir: "/profiles/personal" },
      { profileId: "work", claudeConfigDir: "/profiles/work" },
    ])
  })
})
