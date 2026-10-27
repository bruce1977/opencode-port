// 模型解析层单测：auto 正则随机 / 排除 / fallback / 别名 / ollama / 显式透传（api.md §7）。
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

/** 临时配置文件（进程退出时清理） */
function makeConfig(yaml = "") {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, yaml, "utf8");
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return configPath;
}

function makeResolver({ random = () => 0, yaml = "" } = {}) {
  const config = loadConfig({ CONFIG_PATH: makeConfig(yaml) });
  const client = { listModels: async () => MODELS };
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

test("auto：正则命中池内随机（random=0 → 取第一个）", async () => {
  const yaml = "models:\n  auto:\n    regex: [\"^opencode/\"]\n";
  const { resolver } = makeResolver({ yaml });
  const picked = await resolver.resolve("auto");
  assert.equal(picked.providerID, "opencode");
  assert.equal(picked.name, "opencode/flint-40b-free");
});

test("auto：exclude 剔除后池空 → fallback；无 fallback → 503", async () => {
  const yaml = [
    "models:",
    "  auto:",
    '    regex: ["^opencode/"]',
    '    exclude: ["opencode/flint-40b-free", "opencode/glm-4.6-free", "opencode/gpt-5-free"]',
    '    fallback: "opencode/glm-4.6-free"',
  ].join("\n");
  const { resolver } = makeResolver({ yaml });
  const picked = await resolver.resolve("auto");
  assert.equal(picked.name, "opencode/glm-4.6-free");

  const noFallback = makeResolver({ yaml: "models:\n  auto:\n    regex: [\"^none/\"]\n" });
  await assert.rejects(() => noFallback.resolver.resolve("auto"), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "no_available_model");
    return true;
  });
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
  const yaml = "models:\n  auto:\n    regex: [\"^opencode/\"]\n";
  const { resolver } = makeResolver({ yaml });
  const ok = await resolver.resolveBuiltinOnly("opencode/flint-40b-free");
  assert.equal(ok.providerID, "opencode");
  await assert.rejects(() => resolver.resolveBuiltinOnly("auto"), (e) => e.code === "invalid_model");
  await assert.rejects(() => resolver.resolveBuiltinOnly("ollama/qwen3:4b"), (e) => e.code === "invalid_model");
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
