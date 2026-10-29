// Token usage logging: prompt = input + cache.read, completion = output, plus reasoning/cache/cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { logUsage } from "../src/core/usage.mjs";

function captureLogger() {
  const calls = [];
  return { calls, info(fields, message) { calls.push({ fields, message }); } };
}

test("logUsage: maps OpenCode tokens to a structured usage log line", async () => {
  const logger = captureLogger();
  const result = {
    model: "opencode/glm-4.6-free",
    tokens: { input: 4, output: 20, reasoning: 3, cache: { read: 400, write: 5 } },
    cost: 0.5,
  };

  logUsage(logger, {
    endpoint: "/v1/chat/completions",
    model: "opencode/glm-4.6-free",
    stream: true,
    startedAt: Date.now() - 42,
    result,
  });

  assert.equal(logger.calls.length, 1);
  const { fields, message } = logger.calls[0];
  assert.equal(message, "inference usage");
  assert.equal(fields.event, "usage");
  assert.equal(fields.endpoint, "/v1/chat/completions");
  assert.equal(fields.model, "opencode/glm-4.6-free");
  assert.equal(fields.stream, true);
  assert.equal(fields.prompt_tokens, 404);
  assert.equal(fields.completion_tokens, 20);
  assert.equal(fields.reasoning_tokens, 3);
  assert.equal(fields.cache_read, 400);
  assert.equal(fields.cache_write, 5);
  assert.equal(fields.cost, 0.5);
  assert.ok(fields.duration_ms >= 42);
});

test("logUsage: missing tokens/cost fall back to zeros", async () => {
  const logger = captureLogger();
  logUsage(logger, {
    endpoint: "/v1/web-search",
    model: "ollama-local/qwen3.5:9b",
    startedAt: Date.now(),
    result: {},
  });

  const { fields } = logger.calls[0];
  assert.equal(fields.prompt_tokens, 0);
  assert.equal(fields.completion_tokens, 0);
  assert.equal(fields.reasoning_tokens, 0);
  assert.equal(fields.cache_read, 0);
  assert.equal(fields.cache_write, 0);
  assert.equal(fields.cost, 0);
  assert.equal(fields.stream, false);
});
