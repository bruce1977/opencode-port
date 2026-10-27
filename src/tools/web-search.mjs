// web-search 独立 API 实现（api.md §8/§9）：
// 指定内置模型 → 优先 OpenCode 2.x 服务端一等公民 websearch.query()，失败则回退自实现 SearchProvider。
// 输入关键词，返回匹配网页的段落文字（text），可选综合答案（answer，由 model 驱动）。
import { badRequest, upstreamError } from "../core/errors.mjs";
import { fetchParagraphs } from "./fetch-page.mjs";
import { createSearchProvider } from "./search-providers.mjs";

const SYNTHESIZE_TIMEOUT_MS = 60000;

/**
 * 服务端 websearch（2.x 一等公民）：query → [{url,title,content}]，
 * 随后抓取原页补充段落（服务端 content 作为 snippet 兜底）。
 */
async function serverSearch(ctx, { query, topK, maxCharsPerPage, providerID }) {
  const out = await ctx.client.webSearch({ query, providerID });
  const hits = (out.results ?? []).slice(0, topK);
  return Promise.all(hits.map(async (hit) => {
    const snippet = typeof hit.content === "string" ? hit.content : "";
    const { paragraphs, truncated } = await fetchParagraphs(hit.url, maxCharsPerPage);
    return { title: hit.title ?? "", url: hit.url, snippet, paragraphs, truncated };
  }));
}

/** 兜底路径：SearchProvider 检索 → 逐页抓取段落 */
async function fallbackSearch(ctx, { query, topK, locale, maxCharsPerPage }) {
  const provider = createSearchProvider({ config: ctx.config, searchApiKey: ctx.config.searchApiKey, logger: ctx.logger });
  const hits = await provider.search({ query, topK, locale });
  const results = await Promise.all(hits.map(async (hit) => {
    const { paragraphs, truncated } = await fetchParagraphs(hit.url, maxCharsPerPage);
    return { title: hit.title, url: hit.url, snippet: hit.snippet, paragraphs, truncated };
  }));
  return results.filter((item) => item.paragraphs.length > 0 || item.snippet);
}

/** synthesize=true 时：用同一内置模型把段落综合成答案（2.x：单 text prompt） */
async function synthesizeAnswer(ctx, { model, query, text }) {
  const session = await ctx.client.createSession({
    model: { providerID: model.providerID, id: model.modelID },
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTHESIZE_TIMEOUT_MS);
    try {
      const result = await ctx.client.prompt({
        sessionId: session.id,
        text: `以下是关于「${query}」的网页检索段落，请基于这些内容写一段综合回答，不要编造：\n\n${text}`,
      });
      if (result.error) throw upstreamError(`综合答案生成失败：${result.error}`);
      return result.text.trim();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await ctx.client.deleteSession(session.id);
  }
}

/**
 * 执行一次 web-search 请求（api.md §8 的完整语义）。
 * @returns {Promise<object>} §8.3 响应体
 */
export async function runWebSearch(ctx, params) {
  const {
    model: requestedModel,
    query,
    topK,
    maxCharsPerPage,
    locale = "zh-CN",
    synthesize,
    includeSources = true,
  } = params;

  if (!query || typeof query !== "string" || !query.trim()) {
    throw badRequest("query 缺失或为空", "invalid_request");
  }
  if (!requestedModel) {
    throw badRequest("model 缺失：web-search 必须指定内置模型（或在 config.yaml 的 web_search.model 配置默认值）", "invalid_model");
  }
  const model = await ctx.resolver.resolveBuiltinOnly(requestedModel);

  const effectiveTopK = topK ?? ctx.config.search.topK;
  const effectiveMaxChars = maxCharsPerPage ?? ctx.config.search.maxCharsPerPage;

  // 2.x：服务端 websearch 优先（服务端自选已配置后端）；失败回退自实现 SearchProvider（api.md §9.1）
  let results = null;
  let engine = null;
  try {
    results = await serverSearch(ctx, { query, topK: effectiveTopK, maxCharsPerPage: effectiveMaxChars });
    engine = "opencode-websearch";
  } catch (error) {
    ctx.logger?.warn({ err: error }, "服务端 websearch 失败，回退兜底后端");
  }
  if (!results) {
    results = await fallbackSearch(ctx, { query, topK: effectiveTopK, locale, maxCharsPerPage: effectiveMaxChars });
    engine = ctx.config.search.provider;
  }
  if (results.length === 0) {
    throw upstreamError("检索无任何结果（服务端与兜底后端均失败或为空）");
  }

  // 体积控制：逐页截断 + 整体 text 拼接（单页抓取截断或拼接超限均置 truncated）
  let truncated = false;
  const normalized = results.map((item) => {
    let paragraphs = item.paragraphs;
    if (item.truncated || paragraphs.join("\n\n").length > effectiveMaxChars) {
      truncated = true;
      paragraphs = truncateParagraphs(paragraphs, effectiveMaxChars);
    }
    if (paragraphs.length === 0 && item.snippet) {
      paragraphs = [item.snippet]; // 无段落时用摘要兜底，保证 text 非空
    }
    return { title: item.title, url: item.url, snippet: item.snippet ?? "", paragraphs };
  });

  const text = normalized
    .map((item) => item.paragraphs.join("\n\n"))
    .filter(Boolean)
    .join("\n\n");

  let answer = null;
  if (synthesize) {
    answer = await synthesizeAnswer(ctx, { model, query, text });
  }

  return {
    query: query.trim(),
    model: model.name,
    engine,
    answer,
    truncated,
    results: includeSources ? normalized : undefined,
    text,
    sources: normalized.map((item) => item.url),
  };
}

function truncateParagraphs(paragraphs, maxChars) {
  const out = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    if (used + paragraph.length > maxChars) {
      const remain = maxChars - used;
      if (remain > 50) out.push(paragraph.slice(0, remain));
      break;
    }
    out.push(paragraph);
    used += paragraph.length + 2;
  }
  return out;
}
