// Swagger / OpenAPI integration test: /docs UI, /docs/json spec content and per-endpoint schemas.
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { AJV_OPTIONS } from "../src/api/fastify-options.mjs";
import { createAuthHook } from "../src/api/auth.mjs";
import { registerOpenApi } from "../src/api/openapi.mjs";
import { registerHealthRoutes } from "../src/api/routes/health.mjs";
import { registerModelsRoutes } from "../src/api/routes/models.mjs";
import { registerAliasesRoutes } from "../src/api/routes/aliases.mjs";
import { registerChatRoutes } from "../src/api/routes/chat.mjs";
import { registerResponseRoutes } from "../src/api/routes/responses.mjs";
import { registerMessagesRoutes } from "../src/api/routes/messages.mjs";
import { registerWebSearchRoutes } from "../src/api/routes/web-search.mjs";

async function makeApp(t, { apiKeyEnabled = false, prompt } = {}) {
  const app = Fastify({ logger: false, ajv: AJV_OPTIONS });
  const config = {
    port: 10000,
    apiKeyEnabled,
    apiKeys: apiKeyEnabled ? ["test-key"] : [],
    modelAliases: { flint: "opencode/flint-40b-free" },
    ollamaAliases: { qwen: "ollama/qwen3:4b" },
  };
  // Same registration point as the real entry point: onRequest runs before body validation
  app.addHook("onRequest", createAuthHook({ config }));
  const ctx = {
    config,
    client: {
      baseUrl: "http://127.0.0.1:10001",
      getServerInfo: async () => ({ version: "2.2.0" }),
      createSession: async () => ({ id: "ses_test" }),
      deleteSession: async () => {},
      prompt: prompt ?? (async () => ({ text: "stub", finish: "stop", tokens: { input: 1, output: 2 }, error: null })),
    },
    resolver: {
      resolve: async () => ({ providerID: "opencode", modelID: "flint-40b-free", name: "opencode/flint-40b-free" }),
      listAllowed: async () => ({
        auto: { id: "auto", owned_by: "gateway", description: "白名单内内置模型随机" },
        builtins: [],
        ollama: [],
      }),
    },
    serverManager: { mode: () => "reused" },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  };

  await registerOpenApi(app, { config });
  registerHealthRoutes(app, { ctx });
  registerModelsRoutes(app, { ctx });
  registerAliasesRoutes(app, { ctx });
  registerChatRoutes(app, { ctx });
  registerResponseRoutes(app, { ctx });
  registerMessagesRoutes(app, { ctx });
  registerWebSearchRoutes(app, { ctx });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test("GET /health 返回网关与后端状态", async (t) => {
  const app = await makeApp(t);

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.gateway, "opencode-api-gateway");
  assert.equal(body.opencode.healthy, true);
  assert.equal(body.opencode.version, "2.2.0");
  assert.equal(typeof body.uptime_sec, "number");
});

test("GET /v1/models 返回虚拟模型 auto", async (t) => {
  const app = await makeApp(t);

  const response = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.object, "list");
  assert.equal(body.data[0].id, "auto");
  assert.equal(body.data[0].owned_by, "gateway");
});

test("GET /v1/aliases 返回配置的短名映射（按 alias 排序）", async (t) => {
  const app = await makeApp(t);

  const response = await app.inject({ method: "GET", url: "/v1/aliases" });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, [
    { alias: "flint", model: "opencode/flint-40b-free", source: "models.aliases" },
    { alias: "qwen", model: "ollama/qwen3:4b", source: "ollama.aliases" },
  ]);
});

test("POST /v1/messages 与 /v1/chat/completions 接受 content 块数组", async (t) => {
  const app = await makeApp(t);
  const blocks = [{ type: "text", text: "hi" }];

  const messages = await app.inject({
    method: "POST",
    url: "/v1/messages",
    payload: {
      model: "flint",
      max_tokens: 16,
      system: [{ type: "text", text: "terse" }],
      messages: [{ role: "user", content: blocks }],
    },
  });
  assert.equal(messages.statusCode, 200);
  assert.equal(messages.json().content[0].text, "stub");

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "flint", messages: [{ role: "user", content: blocks }] },
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(chat.json().choices[0].message.content, "stub");
});

test("模型额度耗尽 → 429 quota_exceeded（不被包成 500）", async (t) => {
  const app = await makeApp(t, {
    prompt: async () => ({
      text: "",
      finish: "error",
      tokens: null,
      error: "provider.free-limit: Free usage limit reached",
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "flint", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(response.statusCode, 429);
  assert.match(response.json().message, /free-limit/);
});

test("GET /docs/json 输出 OpenAPI 3.1 且覆盖全部端点", async (t) => {
  const app = await makeApp(t);

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  assert.equal(response.statusCode, 200);

  const spec = response.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.title, "OpenCode API Gateway");
  // Relative URL: Swagger UI sends requests against the origin serving the document, avoiding cross-origin Failed to fetch when accessed via localhost / a LAN IP
  assert.equal(spec.servers[0].url, "/");

  for (const path of [
    "/health",
    "/v1/models",
    "/v1/aliases",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/web_search",
  ]) {
    assert.ok(spec.paths[path], `缺少路径 ${path}`);
  }

  assert.equal(spec.paths["/health"].get.tags[0], "health");
  assert.equal(spec.paths["/v1/web_search"].post.tags[0], "web-search");
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.ok(spec.components.securitySchemes.anthropicApiKey);
});

test("请求体 schema 由 zod 生成（保留默认值）", async (t) => {
  const app = await makeApp(t);

  const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
  const chatSchema =
    spec.paths["/v1/chat/completions"].post.requestBody.content["application/json"].schema;

  assert.deepEqual(chatSchema.required, ["messages"]);
  assert.equal(chatSchema.properties.model.default, "auto");
  assert.equal(chatSchema.properties.stream.default, false);
  assert.equal(chatSchema.properties.messages.minItems, 1);
});

test("API_KEY_ENABLED 时文档声明 security", async (t) => {
  const app = await makeApp(t, { apiKeyEnabled: true });

  const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
  assert.deepEqual(spec.security, [{ bearerAuth: [] }, { anthropicApiKey: [] }]);
});

test("API_KEY_ENABLED 时鉴权先于请求体校验（无 key 只得 401，不得读到 schema 报错）", async (t) => {
  const app = await makeApp(t, { apiKeyEnabled: true });

  const anonymous = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
  assert.equal(anonymous.statusCode, 401);
  // The contract error shape comes from setErrorHandler (index.mjs); here only the absence of schema feedback matters
  assert.ok(!anonymous.body.includes("messages"), `no validation details may reach an unauthenticated caller: ${anonymous.body}`);

  // Same request with a key reaches validation, proving the 401 above was the auth gate, not a route miss
  const keyed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer test-key" },
    payload: {},
  });
  assert.equal(keyed.statusCode, 400);
});

test("GET /docs 返回 Swagger UI 页面", async (t) => {
  const app = await makeApp(t);

  const response = await app.inject({ method: "GET", url: "/docs" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
});
