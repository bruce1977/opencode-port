// 网页抓取与轻量正文抽取：对结果 URL 发 GET，抽取 <p> 段落并按上限截断（api.md §9、design.md §8 风险表）。
// 单页失败返回空段落，不影响其余页（api.md §8.4）。
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB 上限，防大页面拖垮内存
const MIN_PARAGRAPH_CHARS = 30; // 过滤导航/版权等短文本
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const decodeEntities = (text) => text
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&nbsp;/g, " ");

/**
 * 抓取单个 URL 并抽取正文段落。
 * @returns {Promise<{ paragraphs: string[], truncated: boolean }>}
 */
export async function fetchParagraphs(url, maxChars) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { paragraphs: [], truncated: false };
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/html|xml|plain/i.test(contentType)) return { paragraphs: [], truncated: false };

    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return extractParagraphs(html, maxChars);
  } catch {
    return { paragraphs: [], truncated: false }; // 超时/反爬 → 空段落
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 抽 <p> 段落并按 maxChars 截断（可独立单测） */
export function extractParagraphs(html, maxChars) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const paragraphs = [];
  let used = 0;
  let truncated = false;
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const text = decodeEntities(match[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    if (used + text.length > maxChars) {
      truncated = true;
      break;
    }
    paragraphs.push(text);
    used += text.length + 2; // \n\n
  }
  return { paragraphs, truncated };
}
