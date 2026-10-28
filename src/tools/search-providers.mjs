// Fallback search backends (api.md §9.1): duckduckgo (free by default) / bing / brave / custom.
// Every outbound request carries a timeout and AbortSignal (AGENTS.md §4.3).
import { upstreamError } from "../core/errors.mjs";

const REQUEST_TIMEOUT_MS = 10000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * @typedef {object} SearchHit
 * @property {string} title
 * @property {string} url
 * @property {string} snippet
 */

async function fetchText(url, { headers = {}, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT, ...headers },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, text: await res.text() };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (text) => text
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, " ");

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** DuckDuckGo HTML endpoint (no key required): parse result__a / result__snippet */
async function searchDuckDuckGo({ query, topK, locale }) {
  const params = new URLSearchParams({ q: query, kl: locale || "wt-wt" });
  const { ok, text, error } = await fetchText(`https://html.duckduckgo.com/html/?${params}`);
  if (!ok) throw upstreamError(`duckduckgo search failed: ${error?.message ?? "no details"}`);
  const hits = [];
  const anchorRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors = [];
  let match;
  while ((match = anchorRe.exec(text)) !== null && anchors.length < topK) {
    // DDG redirect links carry an uddg parameter; decode the real URL
    let url = match[1];
    try {
      const parsed = new URL(url, "https://duckduckgo.com");
      url = parsed.searchParams.get("uddg") ? decodeURIComponent(parsed.searchParams.get("uddg")) : url;
    } catch { /* Keep the original link as a fallback */ }
    anchors.push({ url, title: stripTags(match[2]) });
  }
  const snippets = [];
  while ((match = snippetRe.exec(text)) !== null && snippets.length < topK) {
    snippets.push(stripTags(match[1]));
  }
  anchors.forEach((anchor, index) => {
    hits.push({ title: anchor.title, url: anchor.url, snippet: snippets[index] ?? "" });
  });
  return hits;
}

/** Bing HTML endpoint: parse <li class="b_algo"> result blocks */
async function searchBing({ query, topK, locale }) {
  const params = new URLSearchParams({ q: query, count: String(topK), setlang: locale || "en" });
  const { ok, text, error } = await fetchText(`https://www.bing.com/search?${params}`);
  if (!ok) throw upstreamError(`bing search failed: ${error?.message ?? "no details"}`);
  const hits = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g;
  let match;
  while ((match = blockRe.exec(text)) !== null && hits.length < topK) {
    hits.push({ title: stripTags(match[2]), url: match[1], snippet: match[3] ? stripTags(match[3]) : "" });
  }
  return hits;
}

/** Brave Search API (requires SEARCH_API_KEY) */
async function searchBrave({ query, topK, locale, apiKey }) {
  if (!apiKey) throw upstreamError("the brave backend requires SEARCH_API_KEY");
  const params = new URLSearchParams({ q: query, count: String(topK), search_lang: locale || "en" });
  const { ok, text, error } = await fetchText(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (!ok) throw upstreamError(`brave search failed: ${error?.message ?? "no details"}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw upstreamError("brave responded with invalid JSON");
  }
  return (data?.web?.results ?? []).slice(0, topK).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.description ?? "",
  }));
}

/** custom: a self-hosted gateway; the contract is GET base_url?q=&count=&lang= returning [{title,url,snippet}] or {results:[…]} */
async function searchCustom({ query, topK, locale, baseUrl, headers }) {
  if (!baseUrl) throw upstreamError("the custom backend requires search.base_url");
  const params = new URLSearchParams({ q: query, count: String(topK), lang: locale || "en" });
  const { ok, text, error } = await fetchText(`${baseUrl}?${params}`, { headers });
  if (!ok) throw upstreamError(`custom search failed: ${error?.message ?? "no details"}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw upstreamError("the custom backend responded with invalid JSON");
  }
  const list = Array.isArray(data) ? data : (data?.results ?? []);
  return list.slice(0, topK).map((item) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: String(item.snippet ?? item.description ?? ""),
  }));
}

/**
 * Build a SearchProvider from config (interface contract in api.md §9.1).
 * @returns {{ name: string, search: (args: { query: string, topK: number, locale?: string }) => Promise<SearchHit[]> }}
 */
export function createSearchProvider({ config, searchApiKey, logger }) {
  const base = { provider: config.search.provider, topK: config.search.topK };
  logger?.debug(base, "Using fallback search backend");

  const impl = {
    duckduckgo: searchDuckDuckGo,
    bing: searchBing,
    brave: searchBrave,
    custom: searchCustom,
  }[config.search.provider];

  return {
    name: config.search.provider,
    search: ({ query, topK, locale }) =>
      impl({ query, topK, locale, apiKey: searchApiKey, baseUrl: config.search.baseUrl, headers: config.search.headers }),
  };
}
