// Config layer: validates environment variables (deployment/secrets), config/config.yaml (business defaults)
// and the API keys file (one key per line), exposing only AppConfig to the business layer
// (AGENTS.md §5: no process.env in business code).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import YAML from "yaml";

// Boolean values in env: z.coerce.boolean() cannot be used ("false" would become true)
const boolish = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === "") return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}, z.boolean());

// Compose injects `${VAR:-}` as an empty string: an empty optional must mean "unset", not a validation error
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  OPENCODE_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(10001),
  OPENCODE_SERVER_URL: optionalText,
  OPENCODE_SERVER_PASSWORD: z.string().default(""),
  API_KEY_ENABLED: boolish.default(false),
  // Additional single key, merged with the keys file (useful for `-e API_KEY=...` one-off access)
  API_KEY: z.string().default(""),
  API_KEYS_FILE: optionalText.default("./config/.keys"),
  SEARCH_API_KEY: z.string().default(""),
  CONFIG_PATH: z.string().trim().min(1).default("./config/config.yaml"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

// Regexes in config.yaml: a compile failure must fail fast at startup, not on the first auto request
const regexString = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, { message: "is not a valid regular expression" });

const fileSchema = z.object({
  models: z.object({
    // Allowlist for both /v1/models and the auto pool: full model names must match one of these
    // regexes; an empty list means no filtering
    allow: z.array(regexString).default([]),
    auto: z.object({
      exclude: z.array(z.string()).default([]),
      fallback: z.string().default(""),
      // zod 4: .default() is used as the output directly and skips schema parsing;
      // only .prefault() parses defaults from an empty object
    }).prefault({}),
    aliases: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  ollama: z.object({
    aliases: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  web_search: z.object({
    model: z.string().default(""),
    synthesize_default: z.boolean().default(false),
  }).prefault({}),
  search: z.object({
    provider: z.enum(["duckduckgo", "bing", "brave", "custom"]).default("duckduckgo"),
    base_url: z.string().default(""),
    headers: z.record(z.string(), z.string()).default({}),
    top_k: z.coerce.number().int().min(1).max(50).default(5),
    max_chars_per_page: z.coerce.number().int().min(200).max(50000).default(4000),
  }).prefault({}),
  session: z.object({
    ttl_min: z.coerce.number().int().min(1).default(30),
  }).prefault({}),
});

/**
 * Minimal .env loader (active by default for `npm start` / `npm run dev`).
 * Semantics follow dotenv: KEY=VALUE, skip # comments and blank lines, optional export prefix and quotes,
 * **already existing environment variables win** (real env overrides .env); a missing file is skipped
 * silently (having no .env inside a container is expected).
 * No dotenv dependency (AGENTS.md §2: runtime dependency budget); good enough, full dotenv syntax not required.
 * @param {string} [path] .env path (relative to the process cwd)
 * @param {Record<string, string | undefined>} [env] injection point (tests pass an object, defaults to process.env)
 * @returns {boolean} whether the file was loaded successfully
 */
export function loadDotEnv(path = ".env", env = process.env) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key || env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return true;
}

/**
 * Read the API keys file: one **plaintext** key per line (no encryption, no hashing, no {env:VAR}
 * interpolation — the line is the key), blank lines and `#` comment lines ignored.
 * A missing file yields an empty list (auth then relies on `API_KEY` alone, or refuses everything if none).
 * Lines are trimmed and deduplicated in order; the first key is also used by the self-test as the Bearer token.
 * @param {string} path
 * @returns {string[]}
 */
export function readApiKeys(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw new Error(`API keys file ${path} could not be read: ${error.code ?? error.message}`, { cause: error });
  }
  const keys = [];
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!keys.includes(trimmed)) keys.push(trimmed);
  }
  return keys;
}

function parse(schema, input, label) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} validation failed: ${detail}`);
  }
  return result.data;
}

function readYamlFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null; // no config file: use defaults for everything
    throw error;
  }
  try {
    return YAML.parse(raw) ?? {};
  } catch (error) {
    throw new Error(`Config file ${path} is not valid YAML: ${error.message}`, { cause: error });
  }
}

/** Lowercase the keys of an alias table (model name resolution is case-insensitive, api.md §7.1) */
function lowerKeys(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Load and validate all configuration.
 * @param {Record<string, string | undefined>} [env] injection point (tests pass an object, defaults to process.env)
 */
export function loadConfig(env = process.env) {
  const raw = parse(envSchema, env, "Environment variables");
  const configPath = resolve(raw.CONFIG_PATH);
  const file = parse(fileSchema, readYamlFile(configPath) ?? {}, `Config file ${configPath}`);
  const keysFilePath = resolve(raw.API_KEYS_FILE);
  const apiKeys = [...new Set([raw.API_KEY, ...readApiKeys(keysFilePath)].filter((key) => key !== ""))];

  return Object.freeze({
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    serverPort: raw.OPENCODE_SERVER_PORT,
    serverUrl: raw.OPENCODE_SERVER_URL ?? "",
    serverPassword: raw.OPENCODE_SERVER_PASSWORD,
    apiKeyEnabled: raw.API_KEY_ENABLED,
    /** First accepted key (the self-test calls our own /health with it); the full set is in `apiKeys` */
    apiKey: apiKeys[0] ?? "",
    apiKeys: Object.freeze(apiKeys),
    apiKeysFile: keysFilePath,
    apiKeysFileFound: existsSync(keysFilePath),
    searchApiKey: raw.SEARCH_API_KEY,
    configPath,
    allow: Object.freeze({
      regex: file.models.allow.map((pattern) => new RegExp(pattern, "i")),
      sources: file.models.allow,
    }),
    auto: Object.freeze({
      exclude: file.models.auto.exclude.map((name) => name.toLowerCase()),
      fallback: file.models.auto.fallback,
    }),
    modelAliases: Object.freeze(lowerKeys(file.models.aliases)),
    ollamaAliases: Object.freeze(lowerKeys(file.ollama.aliases)),
    webSearch: Object.freeze({
      model: file.web_search.model,
      synthesizeDefault: file.web_search.synthesize_default,
    }),
    search: Object.freeze({
      provider: file.search.provider,
      baseUrl: file.search.base_url,
      headers: file.search.headers,
      topK: file.search.top_k,
      maxCharsPerPage: file.search.max_chars_per_page,
    }),
    sessionTtlMin: file.session.ttl_min,
  });
}
