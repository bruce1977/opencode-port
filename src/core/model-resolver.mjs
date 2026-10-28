// Model resolution layer: random pick from the auto allowlist / Ollama mapping / aliases / explicit passthrough (api.md §7).
// Depends on backend client.listModels() (2.x models are first-class: ModelInfo[]), with a TTL cache (design.md §4.3).
import { invalidModel, modelNotFound, noAvailableModel } from "./errors.mjs";

const POOL_TTL_MS = 60000;
// api.md §7.5: auto matches on its own; <namespace>/<model-id> allows : / _ . -; bare names go through the alias table (checked inside resolve)
const MODEL_PATTERN = /^(auto|[a-z0-9._-]+(\/[a-z0-9._:/-]+)?)$/i;
const OLLAMA_NAMESPACE = "ollama";
const OLLAMA_LOCAL_PREFIX = "ollama-local/";
const AUTO_ENTRY = Object.freeze({ id: "auto", owned_by: "gateway", description: "白名单内内置模型随机" });

/**
 * @param {object} options
 * @param {ReturnType<import("./opencode-client.mjs").createBackendClient>} options.client
 * @param {ReturnType<import("../config.mjs").loadConfig>} options.config
 * @param {{ debug: Function, warn: Function }} options.logger
 * @param {() => number} [options.random] for injection (tests pass a fixed value)
 */
export function createModelResolver({ client, config, logger, random = Math.random }) {
  let cache = { at: 0, builtins: [], ollama: [] };

  /** Fetch the model list and normalize it into { builtins, ollama } (disabled/deprecated/alpha models are excluded) */
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
    logger.debug({ builtins: builtins.length, ollama: ollama.length }, "model pool refreshed");
    return cache;
  }

  /** models.allow: an empty list means no filtering; otherwise the full model name must match one of the regexes (compiled with i) */
  function matchesAllow(fullName) {
    return config.allow.regex.length === 0 || config.allow.regex.some((re) => re.test(fullName));
  }

  /** auto pool: models.allow match → exclusion list → random; empty pool falls back (api.md §7.2) */
  async function pickAuto() {
    const pool = await refreshPool();
    // ollama-local is a custom provider (only registered in the builtins group); it never joins auto even if it matches allow (api.md §7.2)
    const matched = pool.builtins.filter((model) => {
      const name = model.name.toLowerCase();
      if (name.startsWith(OLLAMA_LOCAL_PREFIX)) return false;
      if (config.auto.exclude.includes(name)) return false;
      return matchesAllow(name);
    });
    if (matched.length > 0) {
      const picked = matched[Math.floor(random() * matched.length)];
      logger.debug({ model: picked.name, pool: matched.length }, "auto picked model");
      return picked;
    }
    if (config.auto.fallback) {
      logger.warn({ fallback: config.auto.fallback }, "auto pool is empty, using fallback");
      return resolve(config.auto.fallback);
    }
    throw noAvailableModel("auto 池为空且未配置 fallback（检查 models.allow / auto.exclude）");
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
   * Resolve the model field of a request (api.md §7.4 priority).
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

    // 2. ollama short-name mapping
    const ollamaAlias = config.ollamaAliases[lower];
    if (ollamaAlias) return resolve(ollamaAlias);

    // 3. builtin short-name mapping
    const builtinAlias = config.modelAliases[lower];
    if (builtinAlias) return resolve(builtinAlias);

    // 4. ollama/<id>
    if (lower.startsWith(`${OLLAMA_NAMESPACE}/`)) {
      return requireOllama(name.slice(OLLAMA_NAMESPACE.length + 1));
    }

    // 5/6. explicit <provider>/<id> (a bare name that missed the alias table → 400)
    if (!name.includes("/")) {
      throw modelNotFound(`未知模型：${name}（裸名只能命中 models.aliases）`);
    }
    return requireBuiltin(name);
  }

  /** For web-search: only explicit builtin models are accepted (auto / ollama are rejected) */
  async function resolveBuiltinOnly(requested) {
    const resolved = await resolve(requested);
    if (resolved.providerID === OLLAMA_NAMESPACE || requested.toLowerCase() === "auto") {
      throw invalidModel(`web-search 必须指定内置模型，不接受 ${requested}`);
    }
    return resolved;
  }

  /**
   * Model resolution for web-search (api.md §8.2): an explicit model (aliases supported) wins;
   * when omitted, try web_search.model → first ollama-local/* → models.auto.fallback in order.
   * Default candidates come from config/live model pool; on failure try the next one so a stale default cannot break the endpoint.
   */
  async function resolveWebSearchModel(requested) {
    if (requested) return resolveBuiltinOnly(requested);

    const pool = await refreshPool();
    const firstLocal = pool.builtins.find((model) => model.name.toLowerCase().startsWith(OLLAMA_LOCAL_PREFIX));
    const candidates = [config.webSearch.model, firstLocal?.name, config.auto.fallback].filter(Boolean);

    const tried = new Set();
    for (const candidate of candidates) {
      if (tried.has(candidate.toLowerCase())) continue;
      tried.add(candidate.toLowerCase());
      try {
        return await resolveBuiltinOnly(candidate);
      } catch (error) {
        if (error.status !== 400) throw error;
        logger.warn({ model: candidate }, "web-search default model unavailable, trying next candidate");
      }
    }
    throw noAvailableModel("web-search 未指定 model，且无可用默认模型（检查 ollama-local/*、web_search.model 或 models.auto.fallback）");
  }

  /** /v1/models: auto + builtins + declared ollama (api.md §3) */
  async function listAll() {
    const pool = await refreshPool(true);
    return {
      auto: AUTO_ENTRY,
      builtins: pool.builtins,
      ollama: pool.ollama,
    };
  }

  /** Public /v1/models listing: only models matching models.allow; the virtual auto entry is always returned */
  async function listAllowed() {
    const pool = await refreshPool(true);
    return {
      auto: AUTO_ENTRY,
      builtins: pool.builtins.filter((model) => matchesAllow(model.name)),
      ollama: pool.ollama.filter((model) => matchesAllow(model.name)),
    };
  }

  return { resolve, resolveBuiltinOnly, resolveWebSearchModel, listAll, listAllowed, refreshPool };
}
