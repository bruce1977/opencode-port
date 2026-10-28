// Model resolution unit tests: auto regex/random, exclusion, fallback, aliases, ollama, explicit pass-through (api.md §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelResolver } from "../src/core/model-resolver.mjs";
import { loadConfig } from "../src/config.mjs";

const MODELS = [
  { providerID: "opencode", modelID: "flint-40b-free", id: "flint-40b-free", status: "active", enabled: true },
  { providerID: "opencode", modelID: "glm-4.6-free", id: "glm-4.6-free", status: "active", enabled: true },
  { providerID: "opencode", modelID: "gpt-5-free", id: "gpt-5-free", status: "active", enabled: true },
  { providerID: "opencode", modelID: "old-free", id: "old-free", status: "deprecated", enabled: true },
  { providerID: "opencode", modelID: "beta-free", id: "beta-free", status: "alpha", enabled: true },
  { providerID: "opencode", modelID: "off-free", id: "off-free", status: "active", enabled: false },
  { providerID: "ollama", modelID: "qwen3:4b", id: "qwen3:4b", status: "active", enabled: true },
  { providerID: "", modelID: "", id: "broken", status: "active", enabled: true },
];

/** Temporary config file (cleaned up on process exit) */
function makeConfig(yaml = "") {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, yaml, "utf8");
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return configPath;
}

function makeResolver({ random = () => 0, yaml = "", models = MODELS } = {}) {
  const config = loadConfig({ CONFIG_PATH: makeConfig(yaml) });
  const client = { listModels: async () => models };
  const logger = { debug() {}, warn() {} };
  const resolver = createModelResolver({ client, config, logger, random });
  return { resolver };
}

test("池过滤：deprecated / alpha / enabled=false / 缺 providerID 均不入池", async () => {
  const { resolver } = makeResolver();
  const { builtins, ollama } = await resolver.listAll();
  const names = builtins.map((m) => m.name).sort();
  assert.deepEqual(names, ["opencode/flint-40b-free", "opencode/glm-4.6-free", "opencode/gpt-5-free"]);
  assert.deepEqual(ollama.map((m) => m.modelID), ["qwen3:4b"]);
});

test("listAllowed：只返回命中 models.allow 的内置与 ollama 模型，并始终带虚拟 auto", async () => {
  const yaml = [
    "models:",
    "  allow:",
    '    - "^opencode/(?:glm|gpt)"',
    '    - "^ollama/qwen"',
  ].join("\n");
  const { resolver } = makeResolver({ yaml });
  const { auto, builtins, ollama } = await resolver.listAllowed();
  assert.equal(auto.id, "auto");
  assert.deepEqual(builtins.map((m) => m.modelID).sort(), ["glm-4.6-free", "gpt-5-free"]);
  assert.deepEqual(ollama.map((m) => m.modelID), ["qwen3:4b"]);
});

test("listAllowed：allow 为空表示不过滤，返回全部可用模型", async () => {
  const { resolver } = makeResolver();
  const { builtins, ollama } = await resolver.listAllowed();
  assert.equal(builtins.length, 3);
  assert.equal(ollama.length, 1);
});

test("listAllowed 只过滤展示：白名单外的模型仍可显式解析", async () => {
  const yaml = "models:\n  allow: [\"^opencode/glm\"]\n";
  const { resolver } = makeResolver({ yaml });
  assert.equal((await resolver.resolve("opencode/flint-40b-free")).modelID, "flint-40b-free");
});

test("auto：白名单正则命中池内随机（random=0 → 取第一个）", async () => {
  const yaml = "models:\n  allow: [\"^opencode/\"]\n";
  const { resolver } = makeResolver({ yaml });
  const picked = await resolver.resolve("auto");
  assert.equal(picked.providerID, "opencode");
  assert.equal(picked.name, "opencode/flint-40b-free");
});

test("auto：exclude 剔除后池空 → fallback；无 fallback → 503", async () => {
  const yaml = [
    "models:",
    "  allow:",
    '    - "^opencode/"',
    "  auto:",
    '    exclude: ["opencode/flint-40b-free", "opencode/glm-4.6-free", "opencode/gpt-5-free"]',
    '    fallback: "opencode/glm-4.6-free"',
  ].join("\n");
  const { resolver } = makeResolver({ yaml });
  const picked = await resolver.resolve("auto");
  assert.equal(picked.name, "opencode/glm-4.6-free");

  const noFallback = makeResolver({ yaml: "models:\n  allow: [\"^none/\"]\n" });
  await assert.rejects(() => noFallback.resolver.resolve("auto"), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "no_available_model");
    return true;
  });
});

test("auto：只在 models.allow 命中的内置模型中轮转（ollama 不入池）", async () => {
  const yaml = "models:\n  allow: [\"^ollama/\", \"^opencode/glm\"]\n";
  const { resolver } = makeResolver({ yaml });
  assert.equal((await resolver.resolve("auto")).modelID, "glm-4.6-free");
});

test("auto：ollama-local 命中 allow 也不入池（api.md §7.2 不含 Ollama 自定义）", async () => {
  const models = [
    { providerID: "ollama-local", modelID: "qwen3.5:9b", id: "qwen3.5:9b", status: "active", enabled: true },
    { providerID: "opencode", modelID: "glm-4.6-free", id: "glm-4.6-free", status: "active", enabled: true },
  ];
  const yaml = "models:\n  allow: [\"^ollama-local/\", \"^opencode/glm\"]\n";
  const { resolver } = makeResolver({ yaml, models });
  // random=0 picks the first pool entry: ollama-local would win first if it were not excluded
  assert.equal((await resolver.resolve("auto")).name, "opencode/glm-4.6-free");
});

test("别名：内置短名与 ollama 短名（大小写不敏感）", async () => {
  const yaml = [
    "models:",
    "  aliases:",
    '    FLINT: "opencode/flint-40b-free"',
    "ollama:",
    "  aliases:",
    '    qwen: "ollama/qwen3:4b"',
  ].join("\n");
  const { resolver } = makeResolver({ yaml });
  assert.equal((await resolver.resolve("flint")).name, "opencode/flint-40b-free");
  assert.equal((await resolver.resolve("FLINT")).name, "opencode/flint-40b-free");
  assert.deepEqual(await resolver.resolve("qwen"), { providerID: "ollama", modelID: "qwen3:4b", name: "ollama/qwen3:4b" });
});

test("显式 <provider>/<id> 透传；未知裸名 / 未知全名报 400", async () => {
  const { resolver } = makeResolver();
  assert.equal((await resolver.resolve("opencode/glm-4.6-free")).modelID, "glm-4.6-free");
  await assert.rejects(() => resolver.resolve("unknown/model"), (e) => e.status === 400 && e.code === "model_not_found");
  await assert.rejects(() => resolver.resolve("bare-name"), (e) => e.status === 400 && e.code === "model_not_found");
});

test("非法形式：带空格 / 无 namespace 之外的怪形式 → 400 invalid_model", async () => {
  const { resolver } = makeResolver();
  await assert.rejects(() => resolver.resolve("opencode/glm 4.6"), (e) => e.code === "invalid_model");
  await assert.rejects(() => resolver.resolve(""), (e) => e.code === "invalid_model");
  await assert.rejects(() => resolver.resolve(null), (e) => e.code === "invalid_model");
});

test("resolveBuiltinOnly：拒绝 auto 与 ollama", async () => {
  const yaml = "models:\n  allow: [\"^opencode/\"]\n";
  const { resolver } = makeResolver({ yaml });
  const ok = await resolver.resolveBuiltinOnly("opencode/flint-40b-free");
  assert.equal(ok.providerID, "opencode");
  await assert.rejects(() => resolver.resolveBuiltinOnly("auto"), (e) => e.code === "invalid_model");
  await assert.rejects(() => resolver.resolveBuiltinOnly("ollama/qwen3:4b"), (e) => e.code === "invalid_model");
});

const LOCAL_MODELS = [
  { providerID: "opencode", modelID: "flint-40b-free", id: "flint-40b-free", status: "active", enabled: true },
  { providerID: "ollama-local", modelID: "qwen3.5:9b", id: "qwen3.5:9b", status: "active", enabled: true },
  { providerID: "ollama-local", modelID: "glm-4.6:9b", id: "glm-4.6:9b", status: "active", enabled: true },
];

test("resolveWebSearchModel：未传 model → 首个 ollama-local/*（与列表顺序无关的 provider 优先）", async () => {
  const { resolver } = makeResolver({ models: LOCAL_MODELS });
  const picked = await resolver.resolveWebSearchModel();
  assert.equal(picked.name, "ollama-local/qwen3.5:9b");
});

test("resolveWebSearchModel：无 ollama-local/* → models.auto.fallback", async () => {
  const yaml = "models:\n  auto:\n    fallback: \"opencode/glm-4.6-free\"\n";
  const { resolver } = makeResolver({ yaml });
  const picked = await resolver.resolveWebSearchModel();
  assert.equal(picked.name, "opencode/glm-4.6-free");
});

test("resolveWebSearchModel：无 ollama-local、无 fallback → 503 no_available_model", async () => {
  const { resolver } = makeResolver();
  await assert.rejects(() => resolver.resolveWebSearchModel(), (e) => e.status === 503 && e.code === "no_available_model");
});

test("resolveWebSearchModel：支持 models.aliases 与 ollama.aliases 短名", async () => {
  const yaml = [
    "models:",
    "  aliases:",
    '    flint: "opencode/flint-40b-free"',
    "ollama:",
    "  aliases:",
    '    qwen: "ollama-local/qwen3.5:9b"',
  ].join("\n");
  const { resolver } = makeResolver({ yaml, models: LOCAL_MODELS });
  assert.equal((await resolver.resolveWebSearchModel("flint")).name, "opencode/flint-40b-free");
  assert.equal((await resolver.resolveWebSearchModel("qwen")).name, "ollama-local/qwen3.5:9b");
  assert.equal((await resolver.resolveWebSearchModel("QWEN")).name, "ollama-local/qwen3.5:9b");
});

test("resolveWebSearchModel：web_search.model 显式覆盖优先；失效时回退到 ollama-local", async () => {
  const explicit = makeResolver({ yaml: "web_search:\n  model: \"ollama-local/glm-4.6:9b\"\n", models: LOCAL_MODELS });
  assert.equal((await explicit.resolver.resolveWebSearchModel()).name, "ollama-local/glm-4.6:9b");

  const stale = makeResolver({ yaml: "web_search:\n  model: \"opencode/gone-free\"\n", models: LOCAL_MODELS });
  assert.equal((await stale.resolver.resolveWebSearchModel()).name, "ollama-local/qwen3.5:9b");
});

test("resolveWebSearchModel：显式 ollama/<id> 仍拒绝", async () => {
  const { resolver } = makeResolver();
  await assert.rejects(() => resolver.resolveWebSearchModel("ollama/qwen3:4b"), (e) => e.code === "invalid_model");
});

test("TTL 缓存：60s 内不重复拉取（listModels 只调一次）", async () => {
  let calls = 0;
  const config = loadConfig({ CONFIG_PATH: makeConfig("") });
  const client = { listModels: async () => { calls += 1; return MODELS; } };
  const resolver = createModelResolver({ client, config, logger: { debug() {}, warn() {} } });
  await resolver.resolve("opencode/flint-40b-free");
  await resolver.resolve("opencode/glm-4.6-free");
  assert.equal(calls, 1);
});
