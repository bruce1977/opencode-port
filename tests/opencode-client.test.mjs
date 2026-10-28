// Backend adapter unit tests: fake fetch emulates opencode serve 2.x (/api/* routes + /api/event SSE),
// covering health probing, model listing, blocking prompt, streaming promptStream (event deltas + tail catch-up), websearch and abort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackendClient, normalizeAssistant } from "../src/core/opencode-client.mjs";

const SESSION_ID = "ses_fake_0001";
const ASSISTANT_ID = "msg_assistant_1";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Emulates opencode serve 2.x:
 * - GET /api/event returns an SSE stream; state.sse.push(event) emits a frame;
 * - POST .../wait resolves after waitDelayMs (deltas are pushed to the event stream first);
 * - everything else returns fixed JSON per method/path; all calls are recorded in calls.
 */
function createFakeBackend({ assistant, deltas = [], waitDelayMs = 5, infoStatus = 200, extraMessages = [] } = {}) {
  const calls = [];
  const state = { sse: null };

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const path = url.pathname;
    const method = init.method ?? "GET";
    let body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, body });

    if (method === "GET" && path === "/api/info") {
      if (infoStatus !== 200) {
        return jsonResponse({ _tag: "UnauthorizedError", message: "Authentication required" }, infoStatus);
      }
      return jsonResponse({ version: "2.2.0", pid: 1, urls: ["http://127.0.0.1:10001"], paths: { tmp: "/tmp" } });
    }

    if (method === "GET" && path === "/api/model") {
      return jsonResponse({
        location: { directory: "/app" },
        data: [
          { id: "flint-40b-free", modelID: "flint-40b-free", providerID: "opencode", status: "active", enabled: true },
        ],
      });
    }

    if (method === "GET" && path === "/api/event") {
      const encoder = new TextEncoder();
      let controller;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          state.sse = null;
        },
      });
      state.sse = {
        push(event) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      };
      // like real fetch: reading the body fails once the signal is aborted
      init.signal?.addEventListener("abort", () => {
        try {
          controller.error(new Error("aborted"));
        } catch {
          // the stream may already be closed
        }
      }, { once: true });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    if (method === "POST" && path === "/api/session") {
      // the session.create client unwraps .data
      return jsonResponse({ data: { id: SESSION_ID, title: "fake", model: body?.model ?? null, location: { directory: "/app" } } });
    }

    if (method === "POST" && path === `/api/session/${SESSION_ID}/prompt`) {
      // the session.prompt client unwraps .data
      return jsonResponse({ data: { id: "msg_user_1", type: "user", delivery: "steer" } });
    }

    if (method === "POST" && path === `/api/experimental/session/${SESSION_ID}/wait`) {
      // push text deltas while waiting (the server emits events as it generates)
      for (const [ordinal, delta] of deltas.entries()) {
        state.sse?.push({
          type: "session.text.delta",
          data: { sessionID: SESSION_ID, assistantMessageID: ASSISTANT_ID, ordinal, delta },
        });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), waitDelayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    }

    if (method === "GET" && path === `/api/session/${SESSION_ID}/message`) {
      // like the real server: newest-first (desc) by default, oldest-first when order=asc
      const all = [...extraMessages, assistant].filter(Boolean);
      const order = url.searchParams.get("order") ?? "desc";
      const sorted = order === "asc" ? all : [...all].reverse();
      return jsonResponse({ data: sorted, cursor: {} });
    }

    if (method === "GET" && path === `/api/session/${SESSION_ID}`) {
      return jsonResponse({ id: SESSION_ID, title: "fake", outcome: "idle" });
    }

    if (method === "PUT" && path.startsWith(`/api/experimental/session/${SESSION_ID}/instructions/entries/`)) {
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && path === `/api/session/${SESSION_ID}/model`) {
      return jsonResponse({});
    }

    if (method === "DELETE" && path === `/api/session/${SESSION_ID}`) {
      return jsonResponse({});
    }

    if (method === "GET" && path === "/api/websearch/provider") {
      return jsonResponse({ data: [{ id: "exa", name: "Exa" }] });
    }

    if (method === "POST" && path === "/api/websearch") {
      return jsonResponse({
        data: {
          providerID: "exa",
          results: [{ url: "https://example.com/a", title: "A", content: "段落A", time: {} }],
        },
      });
    }

    return jsonResponse({ _tag: "NotFoundError", message: `no route: ${method} ${path}` }, 404);
  };

  return { fetchImpl, calls, state };
}

function makeAssistant(overrides = {}) {
  return {
    id: ASSISTANT_ID,
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "flint-40b-free", variant: "default" },
    time: { created: 1 },
    content: [{ type: "text", text: "你好，世界" }],
    finish: "stop",
    tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 2, write: 0 } },
    cost: 0,
    ...overrides,
  };
}

test("health/getServerInfo：200 返回 ServerInfo，401 视为不可用", async () => {
  const ok = createFakeBackend();
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", password: "pw", fetch: ok.fetchImpl });
  assert.equal(await client.health(), true);
  const info = await client.getServerInfo();
  assert.equal(info.version, "2.2.0");

  const denied = createFakeBackend({ infoStatus: 401 });
  const client2 = createBackendClient({ baseUrl: "http://127.0.0.1:10001", password: "wrong", fetch: denied.fetchImpl });
  assert.equal(await client2.health(), false);
});

test("listModels：返回 ModelInfo 数组", async () => {
  const fake = createFakeBackend();
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const models = await client.listModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "flint-40b-free");
});

test("带 password 时带 Basic 头（用户名固定 opencode）", async () => {
  const fake = createFakeBackend();
  let seenAuth = null;
  const wrapped = (input, init) => {
    seenAuth = new Headers(init.headers).get("authorization");
    return fake.fetchImpl(input, init);
  };
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", password: "testpass123", fetch: wrapped });
  await client.health();
  assert.equal(seenAuth, `Basic ${Buffer.from("opencode:testpass123").toString("base64")}`);
});

test("prompt（非流式）：create → system 指令注入 → prompt → wait → 归一化结果", async () => {
  const fake = createFakeBackend({ assistant: makeAssistant() });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const session = await client.createSession({ model: { providerID: "opencode", id: "flint-40b-free" } });
  assert.equal(session.id, SESSION_ID);

  const result = await client.prompt({ sessionId: session.id, text: "介绍一下", files: [{ uri: "data:image/png;base64,AA" }], system: "你是助手" });
  assert.equal(result.text, "你好，世界");
  assert.equal(result.finish, "stop");
  assert.equal(result.tokens.input, 11);
  assert.equal(result.cost, 0);
  assert.equal(result.error, null);

  const instruction = fake.calls.find((c) => c.method === "PUT");
  assert.ok(instruction, "应有 instructions entry PUT 调用");
  assert.match(instruction.path, /instructions\/entries\/gateway-system$/);
  assert.equal(instruction.body.value, "你是助手");

  const promptCall = fake.calls.find((c) => c.path.endsWith("/prompt"));
  assert.equal(promptCall.body.text, "介绍一下");
  assert.deepEqual(promptCall.body.files, [{ uri: "data:image/png;base64,AA" }]);
});

test("promptStream：逐个收到 delta，最终文本以消息为准对账补发", async () => {
  const fake = createFakeBackend({ assistant: makeAssistant(), deltas: ["你好", "，"] });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const deltas = [];
  const result = await client.promptStream({ sessionId: SESSION_ID, text: "hi", onDelta: (d) => deltas.push(d) });
  // incremental forwarding + catch-up of the missing tail ("世界")
  assert.deepEqual(deltas, ["你好", "，", "世界"]);
  assert.equal(result.text, "你好，世界");
});

test("promptStream：订阅窗口完全丢失时一次性补发全文", async () => {
  const fake = createFakeBackend({ assistant: makeAssistant(), deltas: [] });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const deltas = [];
  await client.promptStream({ sessionId: SESSION_ID, text: "hi", onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ["你好，世界"]);
});

test("promptStream：忽略其他会话的 delta 事件", async () => {
  const fake = createFakeBackend({ assistant: makeAssistant() });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const deltas = [];
  // pushed by wait once subscribed (this case has no deltas); plus one manual event from another session
  const promise = client.promptStream({ sessionId: SESSION_ID, text: "hi", onDelta: (d) => deltas.push(d) });
  await new Promise((resolve) => setTimeout(resolve, 1));
  fake.state.sse?.push({ type: "session.text.delta", data: { sessionID: "ses_other", assistantMessageID: "x", ordinal: 0, delta: "别会话" } });
  await promise;
  assert.ok(!deltas.includes("别会话"));
  assert.deepEqual(deltas, ["你好，世界"]);
});

test("prompt：续接会话取最新 assistant（多轮历史按 asc 排序，不取到旧轮）", async () => {
  // continuation session: previous assistant turn ("OK") first, new turn ("靛蓝色") last; the server replies desc by default
  const oldTurn = { id: "msg_old", type: "assistant", content: [{ type: "text", text: "OK" }], finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
  const newTurn = makeAssistant({ content: [{ type: "text", text: "靛蓝色" }] });
  const fake = createFakeBackend({ assistant: newTurn, extraMessages: [oldTurn] });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const result = await client.prompt({ sessionId: SESSION_ID, text: "我最喜欢的颜色是什么？" });
  assert.equal(result.text, "靛蓝色");
  const listCall = fake.calls.find((c) => c.method === "GET" && c.path.endsWith("/message"));
  assert.equal(listCall.path.includes("message/"), false, "应请求消息列表而非单条消息");
});

test("promptStream：助手消息内嵌 error 时抛 502 upstream_error", async () => {
  const failing = makeAssistant({
    content: [],
    finish: "error",
    error: { type: "ProviderAuthError", message: "missing credentials" },
  });
  const fake = createFakeBackend({ assistant: failing });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  await assert.rejects(
    () => client.promptStream({ sessionId: SESSION_ID, text: "hi", onDelta: () => {} }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, "opencode_unavailable");
      assert.match(error.message, /ProviderAuthError: missing credentials/);
      return true;
    },
  );
});

test("external signal abort: throws \"inference aborted\"", async () => {
  const fake = createFakeBackend({ assistant: makeAssistant(), waitDelayMs: 60000 });
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const controller = new AbortController();
  const promise = client.promptStream({ sessionId: SESSION_ID, text: "hi", onDelta: () => {}, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => promise, /inference aborted/);
});

test("webSearch / listWebSearchProviders：服务端一等公民透传", async () => {
  const fake = createFakeBackend();
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: fake.fetchImpl });
  const providers = await client.listWebSearchProviders();
  assert.deepEqual(providers, [{ id: "exa", name: "Exa" }]);
  const out = await client.webSearch({ query: "opencode" });
  assert.equal(out.providerID, "exa");
  assert.equal(out.results[0].url, "https://example.com/a");
  // omit providerID when not given (the server picks one)
  const call = fake.calls.find((c) => c.path === "/api/websearch");
  assert.equal(call.body.providerID, undefined);
  assert.equal(call.body.query, "opencode");
});

test("deleteSession：后端失败静默（不影响主流程）", async () => {
  const fake = createFakeBackend();
  const failingFetch = async (input, init) => {
    if (init.method === "DELETE") return jsonResponse({ _tag: "SessionNotFoundError", message: "gone" }, 404);
    return fake.fetchImpl(input, init);
  };
  const client = createBackendClient({ baseUrl: "http://127.0.0.1:10001", fetch: failingFetch });
  await client.deleteSession(SESSION_ID); // 不应抛
});

test("normalizeAssistant：文本/思考/工具/finish/tokens 提取", () => {
  const out = normalizeAssistant({
    id: "m1",
    type: "assistant",
    content: [
      { type: "reasoning", text: "想一想" },
      { type: "text", text: "答案A" },
      { type: "text", text: "答案B" },
      {
        type: "tool",
        id: "tool_1",
        name: "websearch",
        state: {
          status: "completed",
          input: { query: "x" },
          content: [{ type: "text", text: "工具输出" }],
        },
      },
      {
        type: "tool",
        id: "tool_2",
        name: "fetch",
        state: { status: "error", input: {}, error: { type: "TimeoutError", message: "too slow" } },
      },
    ],
    finish: "tool-calls",
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
  });
  assert.equal(out.text, "答案A答案B");
  assert.equal(out.reasoning, "想一想");
  assert.equal(out.finish, "tool-calls");
  assert.equal(out.tokens.output, 2);
  assert.equal(out.error, null);
  assert.equal(out.tools.length, 2);
  assert.equal(out.tools[0].output, "工具输出");
  assert.equal(out.tools[1].error, "TimeoutError: too slow");
});

test("normalizeAssistant：缺失 content/finish 容错", () => {
  const out = normalizeAssistant({ id: "m2", type: "assistant" });
  assert.equal(out.text, "");
  assert.equal(out.finish, "unknown");
  assert.equal(out.tokens, null);
  assert.deepEqual(out.tools, []);
});
