// Standalone web-search API implementation (api.md §8/§9):
// Requires a built-in model → prefer the OpenCode 2.x server-side first-class websearch.query(),
// falling back to the local SearchProvider on failure.
// Takes keywords and returns paragraph text (text) from matching pages, plus an optional synthesized answer (answer, driven by model).
import { badRequest, promptUpstreamError, upstreamError } from "../core/errors.mjs";
import { logUsage } from "../core/usage.mjs";
import { fetchParagraphs } from "./fetch-page.mjs";
import { createSearchProvider } from "./search-providers.mjs";

const SYNTHESIZE_TIMEOUT_MS = 60000;

/**
 * Server-side websearch (2.x first-class citizen): query → [{url,title,content}],
 * then fetch the original pages to supplement paragraphs (server content is the snippet fallback).
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

/** Fallback path: SearchProvider lookup → fetch paragraphs page by page */
async function fallbackSearch(ctx, { query, topK, locale, maxCharsPerPage }) {
  const provider = createSearchProvider({ config: ctx.config, searchApiKey: ctx.config.searchApiKey, logger: ctx.logger });
  const hits = await provider.search({ query, topK, locale });
  const results = await Promise.all(hits.map(async (hit) => {
    const { paragraphs, truncated } = await fetchParagraphs(hit.url, maxCharsPerPage);
    return { title: hit.title, url: hit.url, snippet: hit.snippet, paragraphs, truncated };
  }));
  return results.filter((item) => item.paragraphs.length > 0 || item.snippet);
}

/** When synthesize=true: synthesize the paragraphs into an answer with the same built-in model (2.x: single text prompt) */
async function synthesizeAnswer(ctx, { model, query, text }) {
  const session = await ctx.client.createSession({
    model: { providerID: model.providerID, id: model.modelID },
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTHESIZE_TIMEOUT_MS);
    try {
      const startedAt = Date.now();
      const result = await ctx.client.prompt({
        sessionId: session.id,
        text: `以下是关于「${query}」的网页检索段落，请基于这些内容写一段综合回答，不要编造：\n\n${text}`,
      });
      if (result.error) throw promptUpstreamError(result.error);
      logUsage(ctx.logger, { endpoint: "/v1/web-search", model: model.name, stream: false, startedAt, result });
      return result.text.trim();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await ctx.client.deleteSession(session.id);
  }
}

/**
 * Execute a single web-search request (full semantics from api.md §8).
 * @returns {Promise<object>} §8.3 response body
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
  // Explicit model (aliases supported) → web_search.model → first local-provider model → models.auto.fallback
  const model = await ctx.resolver.resolveWebSearchModel(requestedModel);

  const effectiveTopK = topK ?? ctx.config.search.topK;
  const effectiveMaxChars = maxCharsPerPage ?? ctx.config.search.maxCharsPerPage;

  // 2.x: prefer server-side websearch (server picks its configured backend); fall back to the local SearchProvider on failure (api.md §9.1)
  let results = null;
  let engine = null;
  try {
    results = await serverSearch(ctx, { query, topK: effectiveTopK, maxCharsPerPage: effectiveMaxChars });
    engine = "opencode-websearch";
  } catch (error) {
    ctx.logger?.warn({ err: error }, "Server-side websearch failed, falling back to the local search backend");
  }
  if (!results) {
    results = await fallbackSearch(ctx, { query, topK: effectiveTopK, locale, maxCharsPerPage: effectiveMaxChars });
    engine = ctx.config.search.provider;
  }
  if (results.length === 0) {
    throw upstreamError("检索无任何结果（服务端与兜底后端均失败或为空）");
  }

  // Size control: truncate per page and concatenate the overall text (truncated is set if a page was truncated or the concatenation exceeds the limit)
  let truncated = false;
  const normalized = results.map((item) => {
    let paragraphs = item.paragraphs;
    if (item.truncated || paragraphs.join("\n\n").length > effectiveMaxChars) {
      truncated = true;
      paragraphs = truncateParagraphs(paragraphs, effectiveMaxChars);
    }
    if (paragraphs.length === 0 && item.snippet) {
      paragraphs = [item.snippet]; // Fall back to the snippet when there are no paragraphs, keeping text non-empty
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
