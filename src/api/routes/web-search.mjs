// POST /v1/web-search: standalone web-search API (api.md §8).
// The primary retrieval path is OpenCode 2.x server-side websearch (src/tools/web-search.mjs);
// the model field only actually drives the model when synthesize=true (answer synthesis); it is optional — default chain in api.md §8.2.
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { toJsonSchema } from "../openapi.mjs";
import { runWebSearch } from "../../tools/web-search.mjs";

const bodySchema = z.object({
  model: z.string().optional(),
  query: z.string().min(1),
  top_k: z.number().int().positive().max(50).optional(),
  max_chars_per_page: z.number().int().positive().optional(),
  locale: z.string().optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  synthesize: z.boolean().optional(),
  include_sources: z.boolean().optional(),
});

const responseSchema = {
  type: "object",
  required: ["query", "model", "engine", "truncated", "text", "sources"],
  properties: {
    query: { type: "string" },
    model: { type: "string" },
    engine: { type: "string", description: "实际检索后端：opencode-websearch 或兜底 provider" },
    answer: { anyOf: [{ type: "string" }, { type: "null" }] },
    truncated: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "url", "snippet", "paragraphs"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
        },
      },
    },
    text: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
};

export function registerWebSearchRoutes(app, { ctx }) {
  app.post("/v1/web-search", {
    schema: {
      tags: ["web-search"],
      summary: "独立 web-search",
      description:
        "输入关键词返回网页段落文字（api.md §8）。model 可省略或使用别名；缺省时依次取 web_search.model、本地 provider（OLLAMA_LOCAL_PROVIDER，默认 ollama-local）的首个模型、models.auto.fallback。仅 synthesize=true 时驱动答案综合。",
      body: toJsonSchema(bodySchema),
      response: { 200: responseSchema },
    },
  }, async (request) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    return runWebSearch(ctx, {
      model: body.model,
      query: body.query,
      topK: body.top_k,
      maxCharsPerPage: body.max_chars_per_page,
      locale: body.locale,
      recency: body.recency,
      synthesize: body.synthesize ?? ctx.config.webSearch.synthesizeDefault,
      includeSources: body.include_sources,
    });
  });
}
