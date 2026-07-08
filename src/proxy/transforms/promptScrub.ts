const OPENCODE_IDENTITY_LINE = /You are OpenCode, the best coding agent on the planet\.[^\n]*\n+/
const OPENCODE_FEEDBACK_BLOCK = /If the user asks for help or wants to give feedback[\s\S]*?github\.com\/anomalyco\/opencode[^\n]*\n+/
const OPENCODE_DOCS_PARAGRAPH = /When the user directly asks about OpenCode[\s\S]*?opencode\.ai\/docs[^\n]*\n+/
const OPENCODE_OBJECTIVITY_BRAND = /It is best for the user if OpenCode honestly applies/
const OPENCODE_BRAND_TOKEN = /\bOpenCode\b/g
const OMO_IDENTITY_LINE = /You are "Sisyphus"[^\n]*from OhMyOpenCode\.[^\n]*\n+/
const OMO_ENV_BLOCK = /<omo-env>[\s\S]*?<\/omo-env>\n*/
const POWERED_BY_LINE = /You are powered by the model named [^\n]+\n/
const OPENCODE_ENV_BLOCK = /\nHere is some useful information about the environment you are running in:\n<env>[\s\S]*?<\/env>\n/

const GENERIC_IDENTITY = "You are an expert coding assistant. You help users with software engineering tasks by reading files, executing commands, editing code, and writing new files.\n"
const GENERIC_OBJECTIVITY = "It is best for the user if the assistant honestly applies"

export function scrubOpencodeFingerprints(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return systemPrompt
  return systemPrompt
    .replace(OPENCODE_IDENTITY_LINE, GENERIC_IDENTITY)
    .replace(OPENCODE_FEEDBACK_BLOCK, "")
    .replace(OPENCODE_DOCS_PARAGRAPH, "")
    .replace(OPENCODE_OBJECTIVITY_BRAND, GENERIC_OBJECTIVITY)
    .replace(OMO_IDENTITY_LINE, "")
    .replace(OMO_ENV_BLOCK, "")
    .replace(POWERED_BY_LINE, "")
    .replace(OPENCODE_ENV_BLOCK, "\n")
    .replace(OPENCODE_BRAND_TOKEN, "the assistant")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
}

const HERMES_BOILERPLATE_ANCHORS = [
  "You run on Hermes Agent",
  "You run on Claude Code",
] as const

export function stripHermesBoilerplate(systemContext: string | undefined): string | undefined {
  if (systemContext === undefined) return undefined
  let first = -1
  for (const anchor of HERMES_BOILERPLATE_ANCHORS) {
    const idx = systemContext.indexOf(anchor)
    if (idx >= 0 && (first === -1 || idx < first)) first = idx
  }
  if (first < 0) return scrubOpencodeFingerprints(systemContext)
  return scrubOpencodeFingerprints(systemContext.slice(0, first).trimEnd()) ?? ""
}
