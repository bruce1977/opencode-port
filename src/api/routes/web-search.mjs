// POST /v1/web_search：独立 web-search API（api.md §8）。
// 检索主路径为 OpenCode 2.x 服务端 websearch（src/tools/web-search.mjs）；
// model 字段仅在 synthesize=true 时真正驱动模型（综合答案），但仍强制要求内置模型（契约见 api.md §8.2）。
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { runWebSearch } from "../../tools/web-search.mjs";

const bodySchema = z.object({
  model: z.string().optional(),
  query: z.string(),
  top_k: z.number().int().positive().max(50).optional(),
  max_chars_per_page: z.number().int().positive().optional(),
  locale: z.string().optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  synthesize: z.boolean().optional(),
  include_sources: z.boolean().optional(),
});

export function registerWebSearchRoutes(app, { ctx }) {
  app.post("/v1/web_search", async (request) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    return runWebSearch(ctx, {
      model: body.model ?? ctx.config.webSearch.model,
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
