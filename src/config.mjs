// 配置层：集中校验「环境变量（部署/敏感）」与「config/config.yaml（业务默认值）」，
// 对业务层只暴露 AppConfig（AGENTS.md §5：业务代码不出现 process.env）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import YAML from "yaml";

// env 里的布尔值：不能用 z.coerce.boolean()（"false" 会被转成 true）
const boolish = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === "") return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}, z.boolean());

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  OPENCODE_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(10001),
  OPENCODE_SERVER_URL: z.string().trim().min(1).optional(),
  OPENCODE_SERVER_PASSWORD: z.string().default(""),
  API_KEY_ENABLED: boolish.default(false),
  API_KEY: z.string().default(""),
  SEARCH_API_KEY: z.string().default(""),
  CONFIG_PATH: z.string().trim().min(1).default("./config/config.yaml"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

// config.yaml 里的正则：编译失败要在启动期就炸出来，而不是等到第一次 auto 请求
const regexString = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, { message: "不是合法的正则表达式" });

const fileSchema = z.object({
  models: z.object({
    auto: z.object({
      regex: z.array(regexString).default([]),
      exclude: z.array(z.string()).default([]),
      fallback: z.string().default(""),
      // zod 4：.default() 直接作为输出不再过 schema；.prefault() 才会用空对象跑默认值解析
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
 * 极简 .env 加载（`npm start` / `npm run dev` 默认生效）。
 * 语义对齐 dotenv：KEY=VALUE，# 注释与空行跳过，可选 export 前缀与引号，
 * **已存在的环境变量优先**（真实 env 覆盖 .env）；文件不存在时静默跳过（容器内无 .env 属正常）。
 * 不引入 dotenv 依赖（AGENTS.md §2：运行期依赖 4 个上限）；够用即可，不追求完整 dotenv 语法。
 * @param {string} [path] .env 路径（相对进程 cwd）
 * @param {Record<string, string | undefined>} [env] 注入用（测试传对象，默认 process.env）
 * @returns {boolean} 是否成功加载了文件
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

function parse(schema, input, label) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} 校验失败：${detail}`);
  }
  return result.data;
}

function readYamlFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null; // 未提供配置文件时全部走默认值
    throw error;
  }
  try {
    return YAML.parse(raw) ?? {};
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 YAML：${error.message}`, { cause: error });
  }
}

/** 小写化别名表的键（模型名解析大小写不敏感，api.md §7.1） */
function lowerKeys(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * 加载并校验全部配置。
 * @param {Record<string, string | undefined>} [env] 注入用（测试传对象，默认 process.env）
 */
export function loadConfig(env = process.env) {
  const raw = parse(envSchema, env, "环境变量");
  const configPath = resolve(raw.CONFIG_PATH);
  const file = parse(fileSchema, readYamlFile(configPath) ?? {}, `配置文件 ${configPath}`);

  return Object.freeze({
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    serverPort: raw.OPENCODE_SERVER_PORT,
    serverUrl: raw.OPENCODE_SERVER_URL ?? "",
    serverPassword: raw.OPENCODE_SERVER_PASSWORD,
    apiKeyEnabled: raw.API_KEY_ENABLED,
    apiKey: raw.API_KEY,
    searchApiKey: raw.SEARCH_API_KEY,
    configPath,
    auto: Object.freeze({
      regex: file.models.auto.regex.map((pattern) => new RegExp(pattern, "i")),
      regexSources: file.models.auto.regex,
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
