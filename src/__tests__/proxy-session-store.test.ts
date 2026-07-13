/**
 * Shared Session Store Tests
 *
 * Tests the file-based session store that enables cross-proxy
 * session resume when running per-terminal proxies.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  lookupSharedSession,
  lookupSharedSessionByClaudeId,
  storeSharedSession,
  clearSharedSessions,
  setSessionStoreDir,
} from "../proxy/sessionStore"
import { storeSession, lookupSession, clearSessionCache } from "../proxy/session/cache"
import { join } from "node:path"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

describe("Shared session store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-basic-"))
    setSessionStoreDir(tmpDir)
    clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should store and retrieve a session", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const result = lookupSharedSession("session-123")
    expect(result).toBeDefined()
    expect(result!.claudeSessionId).toBe("claude-sess-abc")
  })

  it("should return undefined for unknown session", () => {
    const result = lookupSharedSession("nonexistent")
    expect(result).toBeUndefined()
  })

  it("should update lastUsedAt on store", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const first = lookupSharedSession("session-123")!.lastUsedAt

    // Small delay
    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    storeSharedSession("session-123", "claude-sess-abc")
    const second = lookupSharedSession("session-123")!.lastUsedAt
    expect(second).toBeGreaterThanOrEqual(first)
  })

  it("should preserve createdAt on update", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const created = lookupSharedSession("session-123")!.createdAt

    storeSharedSession("session-123", "claude-sess-def")
    const result = lookupSharedSession("session-123")!
    expect(result.createdAt).toBe(created)
    expect(result.claudeSessionId).toBe("claude-sess-def")
  })

  it("should handle multiple sessions", () => {
    storeSharedSession("sess-1", "claude-1")
    storeSharedSession("sess-2", "claude-2")
    storeSharedSession("sess-3", "claude-3")

    expect(lookupSharedSession("sess-1")!.claudeSessionId).toBe("claude-1")
    expect(lookupSharedSession("sess-2")!.claudeSessionId).toBe("claude-2")
    expect(lookupSharedSession("sess-3")!.claudeSessionId).toBe("claude-3")
  })

  it("should clear all sessions", () => {
    storeSharedSession("sess-1", "claude-1")
    storeSharedSession("sess-2", "claude-2")
    clearSharedSessions()
    expect(lookupSharedSession("sess-1")).toBeUndefined()
    expect(lookupSharedSession("sess-2")).toBeUndefined()
  })

  it("should persist context usage and find it by Claude session ID", () => {
    storeSharedSession(
      "session-usage",
      "claude-sess-usage",
      1,
      undefined,
      undefined,
      undefined,
      { input_tokens: 9, output_tokens: 4 }
    )

    const byKey = lookupSharedSession("session-usage")
    expect(byKey?.contextUsage).toEqual({ input_tokens: 9, output_tokens: 4 })

    const byClaudeId = lookupSharedSessionByClaudeId("claude-sess-usage")
    expect(byClaudeId?.contextUsage).toEqual({ input_tokens: 9, output_tokens: 4 })
  })

  it("should return the freshest match when multiple keys share a Claude session ID", () => {
    storeSharedSession("session-old", "claude-shared")
    const first = lookupSharedSessionByClaudeId("claude-shared")

    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    storeSharedSession("session-new", "claude-shared", 2, undefined, undefined, undefined, {
      input_tokens: 20,
      output_tokens: 8,
    })

    const latest = lookupSharedSessionByClaudeId("claude-shared")
    expect(latest?.lastUsedAt).toBeGreaterThanOrEqual(first?.lastUsedAt ?? 0)
    expect(latest?.messageCount).toBe(2)
    expect(latest?.contextUsage).toEqual({ input_tokens: 20, output_tokens: 8 })
  })

  it("should handle concurrent writes safely", async () => {
    // Simulate two proxies writing at the same time
    const writes = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => storeSharedSession(`sess-${i}`, `claude-${i}`))
    )
    await Promise.all(writes)

    // All should be readable
    for (let i = 0; i < 10; i++) {
      const session = lookupSharedSession(`sess-${i}`)
      expect(session).toBeDefined()
      expect(session!.claudeSessionId).toBe(`claude-${i}`)
    }
  })

  it("should handle corrupted file gracefully", () => {
    writeFileSync(join(tmpDir, "sessions.json"), "not json{{{")
    const result = lookupSharedSession("anything")
    expect(result).toBeUndefined()
    // Should still be able to write after corruption
    storeSharedSession("new-sess", "claude-new")
    expect(lookupSharedSession("new-sess")!.claudeSessionId).toBe("claude-new")
  })
})

describe("storeSession alsoFingerprint shared-store persistence", () => {
  let tmpDir: string
  const messages = [{ role: "user", content: "Check the build" }]
  const continuation = [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "and the tests" },
  ]

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-fp-"))
    setSessionStoreDir(tmpDir)
    clearSharedSessions()
    clearSessionCache()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  // clearSessionCache() also wipes the shared file store, so a restart is
  // simulated by snapshotting sessions.json and restoring it after the wipe —
  // in-memory caches stay empty, only the file survives.
  function simulateRestart() {
    const storeFile = join(tmpDir, "sessions.json")
    const raw = readFileSync(storeFile, "utf8")
    clearSessionCache()
    writeFileSync(storeFile, raw)
  }

  it("persists the fingerprint key so the fallback survives a restart", () => {
    storeSession("cc:session-1", messages, "claude-sess-fp", "/repo", undefined, undefined, true)
    simulateRestart()

    const result = lookupSession(undefined, continuation, "/repo")
    expect(result.type).toBe("continuation")
    if (result.type !== "continuation") throw new Error("unreachable")
    expect(result.session.claudeSessionId).toBe("claude-sess-fp")
  })

  it("does not persist a fingerprint key without the flag", () => {
    storeSession("oc-session-1", messages, "claude-sess-nofp", "/repo")
    simulateRestart()

    const result = lookupSession(undefined, continuation, "/repo")
    expect(result.type).toBe("diverged")
  })
})
