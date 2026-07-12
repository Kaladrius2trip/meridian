export type OpenAiInternalAgent = "openai" | "hermes"

export function resolveOpenAiInternalAgent(value: string | undefined): OpenAiInternalAgent {
  return value?.toLowerCase() === "hermes" ? "hermes" : "openai"
}
