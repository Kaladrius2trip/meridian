const HERMES_BOILERPLATE_ANCHORS = [
  "You run on Hermes Agent",
  "You run on Claude Code",
];

function findBoilerplateStart(systemContext) {
  let first = -1;
  for (const anchor of HERMES_BOILERPLATE_ANCHORS) {
    const idx = systemContext.indexOf(anchor);
    if (idx > 0 && (first === -1 || idx < first)) first = idx;
  }
  return first;
}

export default {
  name: "openai-strip-hermes-boilerplate",
  description: "Truncate Hermes/OpenAI system prompt at operational-boilerplate anchor for Meridian OpenAI adapter.",
  version: "1.0.1-local",
  adapters: ["openai"],

  onRequest(ctx) {
    const sys = ctx && ctx.systemContext;
    if (typeof sys !== "string") return ctx;

    const idx = findBoilerplateStart(sys);
    if (idx <= 0) return ctx;

    const head = sys.slice(0, idx).trimEnd();
    if (!head) return ctx;

    return { ...ctx, systemContext: head };
  },

  HERMES_BOILERPLATE_ANCHORS,
  findBoilerplateStart,
};

export { HERMES_BOILERPLATE_ANCHORS, findBoilerplateStart };
