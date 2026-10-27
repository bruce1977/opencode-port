// POST /v1/chat/completions：OpenAI Chat Completions，SSE 流式（api.md §4）。
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { chatChunk, chatCompletion, messagesToPrompt, newId, toOpenAiFinish } from "../protocol.mjs";
import { clientAbortSignal, rethrowInternal, runPrompt, runStreamPrompt } from "../inference.mjs";

const bodySchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  })).min(1),
  stream: z.boolean().default(false),
  // 采样参数：OpenCode 不透传则记录后忽略（api.md §4）
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.string().optional(),
});

export function registerChatRoutes(app, { ctx }) {
  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    const resolved = await ctx.resolver.resolve(body.model);
    const prompt = messagesToPrompt(body.messages);
    const id = newId("chatcmpl-");

    if (!body.stream) {
      try {
        const result = await runPrompt({ ctx, resolved, prompt, system: prompt.system });
        return chatCompletion({ id, model: resolved.name, text: result.text, tokens: result.tokens, finishReason: toOpenAiFinish(result.finish) });
      } catch (error) {
        rethrowInternal(ctx.logger, error, "chat 推理");
      }
    }

    const sse = startSse(reply);
    const signal = clientAbortSignal(request);
    const created = Math.floor(Date.now() / 1000);
    try {
      sse.send(null, chatChunk({ id, model: resolved.name, created, delta: { role: "assistant", content: "" } }));
      const result = await runStreamPrompt({
        ctx,
        resolved,
        prompt,
        system: prompt.system,
        signal,
        onDelta: (delta) => sse.send(null, chatChunk({ id, model: resolved.name, created, delta: { content: delta } })),
      });
      sse.send(null, chatChunk({ id, model: resolved.name, created, delta: {}, finishReason: toOpenAiFinish(result.finish) }));
      sse.send(null, chatChunk({ id, model: resolved.name, created, delta: {}, tokens: result.tokens }));
      sse.send(null, "[DONE]");
    } catch (error) {
      if (signal.aborted) {
        ctx.logger.warn({ model: resolved.name }, "客户端断开，推理中止");
      } else {
        // SSE 已开始，状态码不可改：记录日志后直接终止流（api.md §2.4）
        ctx.logger.error({ err: error }, "chat 流式推理失败");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}
