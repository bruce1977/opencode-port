// 启动清单展示单测：分组、排序、显示名与空列表兜底（不涉及模型解析规则）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatModelCatalogue, writeModelCatalogue } from "../src/startup-report.mjs";

function entry(providerID, modelID, name) {
  return { providerID, modelID, name: `${providerID}/${modelID}`, info: { name: name ?? modelID } };
}

test("formatModelCatalogue：内置在前、自定义按 provider 分组，包含 auto 提示", () => {
  const text = formatModelCatalogue({
    builtins: [
      entry("opencode", "flint-40b-free", "Flint 40B Free"),
      entry("local-ollama", "qwen3.6:35b", "Qwen 3.6 35B"),
    ],
    ollama: [entry("ollama", "qwen3:8b", "qwen3:8b")],
  });

  assert.match(text, /可用模型：后端 3 个（3 个 provider）/);
  assert.match(text, /内置 · opencode（1 个）/);
  assert.match(text, /自定义 · local-ollama（1 个）/);
  assert.match(text, /自定义 · ollama（1 个）/);
  assert.match(text, /opencode\/flint-40b-free {2}Flint 40B Free/);
  // 显示名与 modelID 相同时不重复追加
  assert.match(text, /ollama\/qwen3:8b\n/);
  assert.match(text, /虚拟 · auto/);
  assert.ok(text.indexOf("opencode（") < text.indexOf("local-ollama（"));
});

test("formatModelCatalogue：空列表给出可诊断提示", () => {
  const text = formatModelCatalogue({ builtins: [], ollama: [] });
  assert.match(text, /后端 0 个/);
  assert.match(text, /未返回可用模型/);
});

test("writeModelCatalogue：写入传入的流并返回文本", () => {
  const chunks = [];
  const stream = { write: (chunk) => chunks.push(chunk) };
  const text = writeModelCatalogue(stream, { builtins: [], ollama: [] });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], `${text}\n`);
});
