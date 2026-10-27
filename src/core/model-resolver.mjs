// 模型解析层：auto 正则随机 / Ollama 映射 / 别名 / 显式透传（api.md §7）。
// 依赖后端 client.listModels()（2.x 模型为一等公民：ModelInfo[]），带 TTL 缓存（design.md §4.3）。
import { invalidModel, modelNotFound, noAvailableModel } from "./errors.mjs";

const POOL_TTL_MS = 60000;
// api.md §7.5：auto 单独匹配；<namespace>/<model-id> 允许 : / _ . -；裸名走别名表（resolve 内再判）
const MODEL_PATTERN = /^(auto|[a-z0-9._-]+(\/[a-z0-9._:/-]+)?)$/i;
const OLLAMA_NAMESPACE = "ollama";

/**
 * @param {object} options
 * @param {ReturnType<import("./opencode-client.mjs").createBackendClient>} options.client
 * @param {ReturnType<import("../config.mjs").loadConfig>} options.config
 * @param {{ debug: Function, warn: Function }} options.logger
 * @param {() => number} [options.random] 注入用（测试传定值）
 */
export function createModelResolver({ client, config, logger, random = Math.random }) {
  let cache = { at: 0, builtins: [], ollama: [] };

  /** 拉取模型列表并归一化为 { builtins, ollama } 两组（禁用/废弃/内测模型不入池） */
  async function refreshPool(force = false) {
    if (!force && Date.now() - cache.at < POOL_TTL_MS) return cache;
    const models = await client.listModels();
    const builtins = [];
    const ollama = [];
    for (const model of models ?? []) {
      if (!model || model.enabled === false) continue;
      if (model.status === "deprecated" || model.status === "alpha") continue;
      const providerID = model.providerID ?? "";
      const modelID = model.modelID ?? model.id ?? "";
      if (!providerID || !modelID) continue;
      const entry = { providerID, modelID, name: `${providerID}/${modelID}`, info: model };
      if (providerID === OLLAMA_NAMESPACE) {
        ollama.push(entry);
      } else {
        builtins.push(entry);
      }
    }
    cache = { at: Date.now(), builtins, ollama };
    logger.debug({ builtins: builtins.length, ollama: ollama.length }, "模型池已刷新");
    return cache;
  }

  /** auto 池：正则匹配 → 排除名单 → 随机；空池走 fallback（api.md §7.2） */
  async function pickAuto() {
    const pool = await refreshPool();
    const matched = pool.builtins.filter((model) => {
      const name = model.name.toLowerCase();
      if (config.auto.exclude.includes(name)) return false;
      return config.auto.regex.some((re) => re.test(name));
    });
    if (matched.length > 0) {
      const picked = matched[Math.floor(random() * matched.length)];
      logger.debug({ model: picked.name, pool: matched.length }, "auto 命中模型");
      return picked;
    }
    if (config.auto.fallback) {
      logger.warn({ fallback: config.auto.fallback }, "auto 池为空，使用 fallback");
      return resolve(config.auto.fallback);
    }
    throw noAvailableModel("auto 池为空且未配置 fallback（检查 models.auto.regex / exclude）");
  }

  function requireBuiltin(name) {
    const found = cache.builtins.find((model) => model.name.toLowerCase() === name.toLowerCase());
    if (!found) throw modelNotFound(`未知模型：${name}`);
    return found;
  }

  function requireOllama(id) {
    const found = cache.ollama.find((model) => model.modelID.toLowerCase() === id.toLowerCase());
    if (!found) {
      throw modelNotFound(`未知 Ollama 模型：${OLLAMA_NAMESPACE}/${id}（需在 opencode.json 的 provider.ollama.models 声明）`);
    }
    return { providerID: OLLAMA_NAMESPACE, modelID: found.modelID, name: found.name };
  }

  /**
   * 解析请求中的 model 字段（api.md §7.4 优先级）。
   * @returns {Promise<{ providerID: string, modelID: string, name: string }>}
   */
  async function resolve(requested) {
    if (typeof requested !== "string" || !MODEL_PATTERN.test(requested.trim())) {
      throw invalidModel(`非法的 model 形式：${requested}（应为 auto 或 <namespace>/<model-id>）`);
    }
    const name = requested.trim();
    const lower = name.toLowerCase();
    await refreshPool();

    if (lower === "auto") return pickAuto();

    // 2. ollama 短名映射
    const ollamaAlias = config.ollamaAliases[lower];
    if (ollamaAlias) return resolve(ollamaAlias);

    // 3. 内置短名映射
    const builtinAlias = config.modelAliases[lower];
    if (builtinAlias) return resolve(builtinAlias);

    // 4. ollama/<id>
    if (lower.startsWith(`${OLLAMA_NAMESPACE}/`)) {
      return requireOllama(name.slice(OLLAMA_NAMESPACE.length + 1));
    }

    // 5/6. 显式 <provider>/<id>（含裸名走别名表未命中 → 400）
    if (!name.includes("/")) {
      throw modelNotFound(`未知模型：${name}（裸名只能命中 models.aliases）`);
    }
    return requireBuiltin(name);
  }

  /** web-search 用：只接受明确的内置模型（拒绝 auto / ollama） */
  async function resolveBuiltinOnly(requested) {
    const resolved = await resolve(requested);
    if (resolved.providerID === OLLAMA_NAMESPACE || requested.toLowerCase() === "auto") {
      throw invalidModel(`web-search 必须指定内置模型，不接受 ${requested}`);
    }
    return resolved;
  }

  /** /v1/models：auto + 内置 + ollama 声明（api.md §3） */
  async function listAll() {
    const pool = await refreshPool(true);
    return {
      auto: { id: "auto", owned_by: "gateway", description: "内置模型正则随机" },
      builtins: pool.builtins,
      ollama: pool.ollama,
    };
  }

  return { resolve, resolveBuiltinOnly, listAll, refreshPool };
}
