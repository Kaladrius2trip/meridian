import { describe, expect, it } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { openAiAdapter } from "../proxy/adapters/openai"
import { hermesAdapter } from "../proxy/adapters/hermes"
import { buildQueryOptions } from "../proxy/query"
import { createRequestContext, runTransformHook } from "../proxy/transform"
import { getAdapterTransforms } from "../proxy/transforms/registry"
import { resolveOpenAiInternalAgent } from "../proxy/openaiAdapterRouting"

function makeContext(extraHeaders: Record<string, string> = {}): any {
  const allHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(extraHeaders)) allHeaders[k.toLowerCase()] = v
  return {
    req: {
      header: (name?: string) => (name ? allHeaders[name.toLowerCase()] : { ...allHeaders }),
    },
  }
}

describe("hermesAdapter", () => {
  it("uses a dedicated identity instead of mutating generic openai", () => {
    expect(hermesAdapter.name).toBe("hermes")
    expect(openAiAdapter.name).toBe("openai")
    expect(hermesAdapter).not.toBe(openAiAdapter)
  })

  it("is resolved via the x-meridian-agent: hermes override", () => {
    expect(detectAdapter(makeContext({ "x-meridian-agent": "hermes" }))).toBe(hermesAdapter)
    expect(detectAdapter(makeContext({ "x-meridian-agent": "Hermes" })).name).toBe("hermes")
  })

  it("strips Claude Code SDK catalog and settings while preserving passthrough tools", () => {
    const ctx = createRequestContext({
      adapter: "hermes",
      body: { tools: [{ name: "Read" }, { name: "execute_code" }] },
      headers: new Headers({ "x-meridian-agent": "hermes" }),
      model: "fable[1m]",
      messages: [{ role: "user", content: "say hello" }],
      systemContext: "You are Hermes Agent",
      tools: [{ name: "execute_code" }],
      stream: false,
      workingDirectory: "/tmp",
    })

    const transformed = runTransformHook(getAdapterTransforms("hermes"), "onRequest", ctx, "hermes")
    const result = buildQueryOptions({
      prompt: "say hello",
      model: transformed.model,
      workingDirectory: transformed.workingDirectory,
      systemContext: transformed.systemContext ?? "",
      claudeExecutable: "/usr/bin/claude",
      passthrough: transformed.passthrough === true,
      stream: transformed.stream,
      sdkAgents: transformed.sdkAgents,
      cleanEnv: {},
      hasDeferredTools: false,
      isUndo: false,
      blockedTools: transformed.blockedTools,
      incompatibleTools: transformed.incompatibleTools,
      mcpServerName: hermesAdapter.getMcpServerName(),
      allowedMcpTools: transformed.allowedMcpTools,
    })

    expect(transformed.sdkAgents).toEqual({})
    expect(transformed.sdkHooks).toBeUndefined()
    expect((result.options as { tools?: readonly unknown[] }).tools).toEqual([])
    expect((result.options as { settingSources?: readonly unknown[] }).settingSources).toEqual([])
  })

  it("truncates Hermes persona boilerplate before Claude Code planning notes", () => {
    const ctx = createRequestContext({
      adapter: "hermes",
      body: {},
      headers: new Headers({ "x-meridian-agent": "hermes" }),
      model: "fable[1m]",
      messages: [{ role: "user", content: "hi" }],
      systemContext: "# Zhora Agent Persona\n\nKeep this.\n\nYou run on Hermes Agent (by Nous Research).\nClaude Code planning notes must not reach SDK.",
      stream: false,
      workingDirectory: "/tmp",
    })

    const transformed = runTransformHook(getAdapterTransforms("hermes"), "onRequest", ctx, "hermes")

    expect(transformed.systemContext).toBe("# Zhora Agent Persona\n\nKeep this.")
  })

  it("strips leading Hermes identity when no user context precedes it", () => {
    const ctx = createRequestContext({
      adapter: "hermes",
      body: {},
      headers: new Headers({ "x-meridian-agent": "hermes" }),
      model: "fable[1m]",
      messages: [{ role: "user", content: "hi" }],
      systemContext: "You run on Hermes Agent (by Nous Research).\nProvider-visible identity must not leak.",
      stream: false,
      workingDirectory: "/tmp",
    })

    const transformed = runTransformHook(getAdapterTransforms("hermes"), "onRequest", ctx, "hermes")

    expect(transformed.systemContext).toBe("")
  })
})

describe("openai adapter isolation", () => {
  it("keeps generic openai on OpenCode transforms", () => {
    const names = getAdapterTransforms("openai").map((transform) => transform.name)

    expect(names).toEqual(["opencode-core"])
  })

  it("preserves only explicit Hermes adapter overrides on OpenAI-compatible hops", () => {
    expect(resolveOpenAiInternalAgent("hermes")).toBe("hermes")
    expect(resolveOpenAiInternalAgent("Hermes")).toBe("hermes")
    expect(resolveOpenAiInternalAgent(undefined)).toBe("openai")
    expect(resolveOpenAiInternalAgent("opencode")).toBe("openai")
  })

  it("scrubs OpenCode fingerprints in the shared Meridian adapter path", () => {
    const ctx = createRequestContext({
      adapter: "opencode",
      body: {},
      headers: new Headers({ "x-opencode-session": "sess-1" }),
      model: "opus[1m]",
      messages: [{ role: "user", content: "hi" }],
      systemContext: [
        "You are OpenCode, the best coding agent on the planet.",
        "You are powered by the model named claude-opus-4-6. The exact model ID is anthropic/claude-opus-4-6",
        "<omo-env>",
        "  Timezone: Europe/Kyiv",
        "</omo-env>",
        "Keep user project rules.",
      ].join("\n"),
      stream: false,
      workingDirectory: "/tmp",
    })

    const transformed = runTransformHook(getAdapterTransforms("opencode"), "onRequest", ctx, "opencode")

    expect(transformed.systemContext).toContain("You are an expert coding assistant.")
    expect(transformed.systemContext).toContain("Keep user project rules.")
    expect(transformed.systemContext).not.toContain("OpenCode")
    expect(transformed.systemContext).not.toContain("powered by the model")
    expect(transformed.systemContext).not.toContain("<omo-env>")
  })
})
