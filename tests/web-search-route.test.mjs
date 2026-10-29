// POST /v1/web-search route-level simulation: only query is required; model supports aliases and the default chain (api.md §8.2).
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerWebSearchRoutes } from "../src/api/routes/web-search.mjs";

const LONG_A = "OpenCode 是一个开源的 AI 编程助手框架，支持多种模型与工具编排能力。".repeat(2);
const PAGE_HTML = `<html><body><p>${LONG_A}</p></body></html>`;
const DDG_HTML = [
  '<a class="result__a" href="https://example.com/a?uddg=https%3A%2F%2Fexample.com%2Fa">结果A</a>',
  '<a class="result__snippet">摘要A</a>',
].join("\n");

const DEFAULT_MODEL = { providerID: "ollama-local", modelID: "qwen3.5:9b", name: "ollama-local/qwen3.5:9b" };

function makeApp() {
  const app = Fastify({ logger: false });
  const ctx = {
    config: {
      search: { provider: "duckduckgo", baseUrl: "", headers: {}, topK: 5, maxCharsPerPage: 4000 },
      webSearch: { model: "", synthesizeDefault: false },
      searchApiKey: "",
    },
    logger: { warn() {}, debug() {}, error() {} },
    resolver: {
      async resolveWebSearchModel(requested) {
        if (!requested) return DEFAULT_MODEL;
        if (requested.toLowerCase() === "qwen3.5") return DEFAULT_MODEL;
        const error = new Error(`未知模型：${requested}`);
        error.status = 400;
        error.code = "model_not_found";
        throw error;
      },
    },
    // Simulate a backend without websearch configured: fall through to the free fallback provider
    client: { webSearch: async () => { throw new Error("server websearch unavailable"); } },
  };
  app.setErrorHandler((error, _request, reply) => {
    // Same as the gateway: Fastify validation errors carry statusCode, business ApiErrors carry status
    const status = error.status ?? error.statusCode ?? 500;
    const code = error.code && !String(error.code).startsWith("FST_")
      ? error.code
      : status === 400 ? "invalid_request" : "internal_error";
    reply.status(status).send({ error: { message: error.message, code } });
  });
  registerWebSearchRoutes(app, { ctx });
  return app;
}

/** Replace global fetch: DDG search page plus result page fetch, avoiding real network requests */
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const html = url.includes("duckduckgo.com") ? DDG_HTML : PAGE_HTML;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return () => { globalThis.fetch = original; };
}

async function withApp(fn) {
  const restore = stubFetch();
  const app = makeApp();
  try {
    await fn(app);
  } finally {
    await app.close();
    restore();
  }
}

test("仅传 query：model 默认走 ollama-local，其余参数取默认值", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web-search",
      payload: { query: "OpenCode 网关" },
    });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.model, "ollama-local/qwen3.5:9b");
    assert.equal(body.engine, "duckduckgo");
    assert.equal(body.answer, null);
    assert.equal(body.truncated, false);
    assert.ok(Array.isArray(body.results), "include_sources 默认 true");
    assert.ok(body.text.length > 0);
  });
});

test("model 支持别名（大小写不敏感）", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web-search",
      payload: { query: "别名", model: "QWEN3.5" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().model, "ollama-local/qwen3.5:9b");
  });
});

test("缺少 query → 400 invalid_request", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web-search",
      payload: { model: "qwen3.5" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_request");
  });
});

test("空白 query → 400 invalid_request", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web-search",
      payload: { query: "   " },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_request");
  });
});

test("显式未知 model → 400 model_not_found", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web-search",
      payload: { query: "未知模型", model: "nope" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "model_not_found");
  });
});
