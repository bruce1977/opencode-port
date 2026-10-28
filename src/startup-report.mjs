// Startup catalogue: turn the result of resolver.listAll() into terminal-readable text.
// Display only; it plays no part in model resolution, which is still governed by core/model-resolver.mjs (api.md §7).
const BUILTIN_PROVIDER = "opencode";

/** @param {{ providerID?: string } | null | undefined} entry */
function providerOf(entry) {
  return entry?.providerID || "unknown";
}

/** @param {string} providerID */
function providerLabel(providerID) {
  if (providerID === BUILTIN_PROVIDER) return "Built-in";
  if (providerID === "unknown") return "Unknown";
  return "Custom";
}

/** @param {{ providerID?: string, modelID?: string, name?: string, info?: { name?: string } }} entry */
function modelLine(entry) {
  const fullName = entry.name || `${providerOf(entry)}/${entry.modelID ?? ""}`;
  const displayName = entry.info?.name;
  if (!displayName || displayName === entry.modelID) return fullName;
  return `${fullName}  ${displayName}`;
}

/**
 * Build the available-model catalogue (pure function, easy to test).
 * @param {{ builtins?: Array<object>, ollama?: Array<object> }} [catalogue]
 * @returns {string} multi-line text without a trailing newline
 */
export function formatModelCatalogue(catalogue = {}) {
  const entries = [...(catalogue.builtins ?? []), ...(catalogue.ollama ?? [])];
  const groups = new Map();
  for (const entry of entries) {
    const provider = providerOf(entry);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(entry);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }
  // Built-in provider first, the rest sorted by name, so local custom models are easy to spot
  const providers = [...groups.keys()].sort((a, b) => {
    if (a === BUILTIN_PROVIDER) return -1;
    if (b === BUILTIN_PROVIDER) return 1;
    return a.localeCompare(b);
  });

  const lines = [
    `Available models: ${entries.length} from the backend (${providers.length} providers) + virtual model auto`,
  ];
  if (entries.length === 0) {
    lines.push("  (the backend returned no usable models: check the opencode sign-in state / provider configuration)");
  }
  for (const provider of providers) {
    const list = groups.get(provider);
    lines.push(`  ${providerLabel(provider)} · ${provider} (${list.length})`);
    for (const entry of list) lines.push(`    - ${modelLine(entry)}`);
  }
  lines.push("  Virtual · auto (picked at random from built-in models allowed by models.allow in config.yaml)");
  return lines.join("\n");
}

/**
 * Write the model catalogue to the given stream (stdout by default; terminal output, not structured logging).
 * @param {NodeJS.WritableStream} stream
 * @param {{ builtins?: Array<object>, ollama?: Array<object> }} catalogue
 * @returns {string} the exact text written
 */
export function writeModelCatalogue(stream, catalogue) {
  const text = formatModelCatalogue(catalogue);
  stream.write(`${text}\n`);
  return text;
}
