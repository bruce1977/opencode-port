// Unit tests for the standalone web-search API: server-side websearch priority / fallback SearchProvider / synthesize / truncation and errors (api.md §8/§9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWebSearch } from "../src/tools/web-search.mjs";

// Long paragraphs (over the 30-character threshold for filtering short text) and HTML containing entities
const LONG_A = "OpenCode 是一个开源的 AI 编程助手框架，支持多种模型与工具编排能力。".repeat(2);
const LONG_B = "网关把 OpenCode 的内置免费模型包装成 OpenAI 与 Anthropic 兼容接口。".repeat(2);

const PAGE_HTML = `<html><body><nav>短</nav><p>${LONG_A}</p><p>${LONG_B}</p></body></html>`;
const DDG_HTML = [
  '<a class="result__a" href="https://example.com/a?uddg=https%3A%2F%2Fexample.com%2Fa">结果A</a>',
  '<a class="result__snippet">摘要A</a>',
].join("\n");

function makeCtx(overrides = {}) {
  const config = {
    search: { provider: "duckduckgo", baseUrl: "", headers: {}, topK: 5, maxCharsPerPage: 4000 },
    webSearch: { model: "", synthesizeDefault: false },
    searchApiKey: "",
  };
  const resolveBuiltinOnly = async (name) => {
    if (name === "auto" || name.startsWith("ollama/")) {
      const error = new Error("invalid model");
      error.status = 400;
      error.code = "invalid_model";
      throw error;
    }
    return { providerID: "opencode", modelID: "flint-40b-free", name: "opencode/flint-40b-free" };
  };
  const ctx = {
    config,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    resolver: {
      resolveBuiltinOnly,
      resolveWebSearchModel: async (name) => resolveBuiltinOnly(name ?? "opencode/flint-40b-free"),
    },
    client: {
      webSearch: async () => ({ providerID: "exa", results: [{ url: "https://example.com/a", title: "A", content: "服务端摘要", time: {} }] }),
      createSession: async () => ({ id: "ses_1" }),
      deleteSession: async () => {},
      prompt: async () => ({ text: "综合答案", finish: "stop", error: null }),
    },
    ...overrides,
  };
  return ctx;
}

/** Temporarily replace global fetch (fetchParagraphs / SearchProvider both use global fetch); returns a restore function */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

test("服务端 websearch 优先：engine=opencode-websearch，段落来自抓取页", async () => {
  const restore = stubFetch(async () => htmlResponse(PAGE_HTML));
  try {
    const out = await runWebSearch(makeCtx(), { model: "opencode/flint-40b-free", query: "OpenCode 网关" });
    assert.equal(out.engine, "opencode-websearch");
    assert.equal(out.query, "OpenCode 网关");
    assert.equal(out.model, "opencode/flint-40b-free");
    assert.deepEqual(out.sources, ["https://example.com/a"]);
    assert.equal(out.results[0].snippet, "服务端摘要");
    assert.ok(out.results[0].paragraphs.length >= 1);
    assert.ok(out.text.includes(LONG_A.slice(0, 20)));
    assert.equal(out.answer, null);
    assert.equal(out.truncated, false);
  } finally {
    restore();
  }
});

test("服务端 websearch 抛错 → 回退 SearchProvider（engine=配置后端）", async () => {
  const ctx = makeCtx({
    client: {
      webSearch: async () => { throw new Error("no provider configured"); },
      createSession: async () => ({ id: "ses_1" }),
      deleteSession: async () => {},
      prompt: async () => ({ text: "x", finish: "stop", error: null }),
    },
  });
  const restore = stubFetch(async (input) => {
    const url = String(input);
    if (url.includes("duckduckgo.com")) return htmlResponse(DDG_HTML);
    return htmlResponse(PAGE_HTML);
  });
  try {
    const out = await runWebSearch(ctx, { model: "opencode/flint-40b-free", query: "兜底" });
    assert.equal(out.engine, "duckduckgo");
    assert.deepEqual(out.sources, ["https://example.com/a"]);
    assert.ok(out.text.length > 0);
  } finally {
    restore();
  }
});

test("服务端与兜底均无结果 → 502 upstream_error", async () => {
  const ctx = makeCtx({
    client: {
      webSearch: async () => ({ providerID: "exa", results: [] }),
      createSession: async () => ({ id: "ses_1" }),
      deleteSession: async () => {},
      prompt: async () => ({ text: "x", finish: "stop", error: null }),
    },
  });
  const restore = stubFetch(async () => htmlResponse("<html><body>无结果页</body></html>"));
  try {
    await assert.rejects(
      () => runWebSearch(ctx, { model: "opencode/flint-40b-free", query: "空" }),
      (error) => error.status === 502 && error.code === "opencode_unavailable",
    );
  } finally {
    restore();
  }
});

test("synthesize=true：用指定内置模型生成 answer", async () => {
  const restore = stubFetch(async () => htmlResponse(PAGE_HTML));
  try {
    const out = await runWebSearch(makeCtx(), { model: "opencode/flint-40b-free", query: "综合", synthesize: true });
    assert.equal(out.answer, "综合答案");
  } finally {
    restore();
  }
});

test("synthesize：模型报错 → 502（不吞错误）", async () => {
  const ctx = makeCtx({
    client: {
      webSearch: async () => ({ providerID: "exa", results: [{ url: "https://example.com/a", title: "A", content: "", time: {} }] }),
      createSession: async () => ({ id: "ses_1" }),
      deleteSession: async () => {},
      prompt: async () => ({ text: "", finish: "error", error: "ProviderAuthError: no creds" }),
    },
  });
  const restore = stubFetch(async () => htmlResponse(PAGE_HTML));
  try {
    await assert.rejects(
      () => runWebSearch(ctx, { model: "opencode/flint-40b-free", query: "综合", synthesize: true }),
      (error) => error.status === 502 && /ProviderAuthError/.test(error.message),
    );
  } finally {
    restore();
  }
});

test("体积控制：单页超 max_chars_per_page 截断 → truncated=true", async () => {
  const restore = stubFetch(async () => htmlResponse(PAGE_HTML));
  try {
    const out = await runWebSearch(makeCtx(), {
      model: "opencode/flint-40b-free",
      query: "截断",
      maxCharsPerPage: 100,
    });
    assert.equal(out.truncated, true);
    assert.ok(out.text.length <= 150);
  } finally {
    restore();
  }
});

test("include_sources=false：不返回 results 明细但 sources 仍给", async () => {
  const restore = stubFetch(async () => htmlResponse(PAGE_HTML));
  try {
    const out = await runWebSearch(makeCtx(), {
      model: "opencode/flint-40b-free",
      query: "精简",
      includeSources: false,
    });
    assert.equal(out.results, undefined);
    assert.deepEqual(out.sources, ["https://example.com/a"]);
  } finally {
    restore();
  }
});

test("抓取失败但有 snippet：以 snippet 兜底成段落", async () => {
  const restore = stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    const out = await runWebSearch(makeCtx(), { model: "opencode/flint-40b-free", query: "摘要兜底" });
    assert.equal(out.results[0].paragraphs[0], "服务端摘要");
    assert.ok(out.text.length > 0);
  } finally {
    restore();
  }
});

test("query 缺失 → 400 invalid_request", async () => {
  await assert.rejects(
    () => runWebSearch(makeCtx(), { query: "  " }),
    (error) => error.status === 400 && error.code === "invalid_request",
  );
  await assert.rejects(
    () => runWebSearch(makeCtx(), { model: "opencode/flint-40b-free" }),
    (error) => error.status === 400 && error.code === "invalid_request",
  );
});
