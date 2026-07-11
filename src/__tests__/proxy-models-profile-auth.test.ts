import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProxyConfig } from "../proxy/types"
import { resetCachedClaudeAuthStatus, resetCachedClaudePath } from "../proxy/models"

type AuthCall = {
  readonly claudeConfigDir: string | undefined
}

type ModelInfo = {
  readonly id: string
  readonly context_window: number
}

type ModelsBody = {
  readonly data: readonly ModelInfo[]
}

type HealthBody = {
  readonly auth?: {
    readonly subscriptionType?: string
  }
}

const PROFILES = [
  { id: "personal", claudeConfigDir: "/profiles/personal" },
  { id: "max", claudeConfigDir: "/profiles/max" },
] satisfies NonNullable<ProxyConfig["profiles"]>

const originalClaudePath = process.env.MERIDIAN_CLAUDE_PATH
const originalCallLog = process.env.MERIDIAN_AUTH_CALL_LOG
let tempDir: string | undefined

const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

function createProfileApp() {
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: PROFILES,
  })
  return app
}

async function installClaudeAuthStub(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "meridian-auth-"))
  const scriptPath = join(tempDir, "claude-auth-stub.js")
  await writeFile(scriptPath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const configDir = process.env.CLAUDE_CONFIG_DIR;
const callLog = process.env.MERIDIAN_AUTH_CALL_LOG;
if (callLog) appendFileSync(callLog, JSON.stringify({ claudeConfigDir: configDir }) + "\\n");
const subscriptionType = configDir === "/profiles/max" ? "max" : "pro";
process.stdout.write(JSON.stringify({ loggedIn: true, email: subscriptionType + "@example.test", subscriptionType }));
`)
  await chmod(scriptPath, 0o755)
  const callLogPath = join(tempDir, "auth-calls.jsonl")
  process.env.MERIDIAN_CLAUDE_PATH = scriptPath
  process.env.MERIDIAN_AUTH_CALL_LOG = callLogPath
  resetCachedClaudePath()
  resetCachedClaudeAuthStatus()
  return callLogPath
}

async function readAuthCalls(callLogPath: string): Promise<readonly AuthCall[]> {
  const text = await readFile(callLogPath, "utf8")
  return text.trim().split("\n").filter(Boolean).map(parseAuthCall)
}

function parseAuthCall(line: string): AuthCall {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== "object") throw new Error("Expected auth call object")
  const claudeConfigDir = "claudeConfigDir" in parsed ? parsed.claudeConfigDir : undefined
  if (claudeConfigDir !== undefined && typeof claudeConfigDir !== "string") {
    throw new Error("Expected auth call CLAUDE_CONFIG_DIR string")
  }
  return { claudeConfigDir }
}

async function readModelsBody(response: Response): Promise<ModelsBody> {
  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Expected /v1/models body with data array")
  }
  const models: ModelInfo[] = []
  for (const item of body.data) {
    if (!item || typeof item !== "object" || !("id" in item) || !("context_window" in item)) {
      throw new Error("Expected model item with id and context_window")
    }
    if (typeof item.id !== "string" || typeof item.context_window !== "number") {
      throw new Error("Expected typed model id and context_window")
    }
    models.push({ id: item.id, context_window: item.context_window })
  }
  return { data: models }
}

async function readHealthBody(response: Response): Promise<HealthBody> {
  const body: unknown = await response.json()
  if (!body || typeof body !== "object") throw new Error("Expected /health object body")
  const auth = "auth" in body ? body.auth : undefined
  if (auth !== undefined && (!auth || typeof auth !== "object")) throw new Error("Expected /health auth object")
  const subscriptionType = auth && "subscriptionType" in auth ? auth.subscriptionType : undefined
  if (subscriptionType !== undefined && typeof subscriptionType !== "string") {
    throw new Error("Expected /health auth.subscriptionType string")
  }
  return subscriptionType === undefined ? {} : { auth: { subscriptionType } }
}

function findModel(models: readonly ModelInfo[], id: string): ModelInfo {
  const model = models.find((item) => item.id === id)
  if (!model) throw new Error(`Expected model ${id}`)
  return model
}

describe("GET /v1/models profile-aware auth", () => {
  beforeEach(() => {
    resetActiveProfile()
    resetCachedClaudePath()
    resetCachedClaudeAuthStatus()
  })

  afterEach(async () => {
    resetActiveProfile()
    resetCachedClaudePath()
    resetCachedClaudeAuthStatus()
    if (originalClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
    else process.env.MERIDIAN_CLAUDE_PATH = originalClaudePath
    if (originalCallLog === undefined) delete process.env.MERIDIAN_AUTH_CALL_LOG
    else process.env.MERIDIAN_AUTH_CALL_LOG = originalCallLog
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  it("uses the same active Max profile auth as /health for Opus 4.8 context", async () => {
    const callLogPath = await installClaudeAuthStub()
    const app = createProfileApp()

    await app.fetch(new Request("http://localhost/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "max" }),
    }))

    const health = await app.fetch(new Request("http://localhost/health"))
    resetCachedClaudeAuthStatus()
    const models = await app.fetch(new Request("http://localhost/v1/models"))

    expect(health.status).toBe(200)
    expect(models.status).toBe(200)
    expect((await readHealthBody(health)).auth?.subscriptionType).toBe("max")
    expect(findModel((await readModelsBody(models)).data, "claude-opus-4-8").context_window).toBe(1_000_000)
    expect(await readAuthCalls(callLogPath)).toEqual([
      { claudeConfigDir: "/profiles/max" },
      { claudeConfigDir: "/profiles/max" },
    ])
  })
})
