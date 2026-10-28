// Startup report rendering unit tests: grouping, ordering, display names and the empty-list fallback (no resolution rules here).
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

  assert.match(text, /Available models: 3 from the backend \(3 providers\)/);
  assert.match(text, /Built-in · opencode \(1\)/);
  assert.match(text, /Custom · local-ollama \(1\)/);
  assert.match(text, /Custom · ollama \(1\)/);
  assert.match(text, /opencode\/flint-40b-free {2}Flint 40B Free/);
  // no duplicate suffix when the display name equals the modelID
  assert.match(text, /ollama\/qwen3:8b\n/);
  assert.match(text, /Virtual · auto/);
  assert.ok(text.indexOf("opencode (") < text.indexOf("local-ollama ("));
});

test("formatModelCatalogue：空列表给出可诊断提示", () => {
  const text = formatModelCatalogue({ builtins: [], ollama: [] });
  assert.match(text, /Available models: 0 from the backend/);
  assert.match(text, /returned no usable models/);
});

test("writeModelCatalogue：写入传入的流并返回文本", () => {
  const chunks = [];
  const stream = { write: (chunk) => chunks.push(chunk) };
  const text = writeModelCatalogue(stream, { builtins: [], ollama: [] });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], `${text}\n`);
});
