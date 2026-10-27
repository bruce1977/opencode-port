// POST /v1/messages：Anthropic Messages API（兼容 Claude SDK），SSE 流式（api.md §6）。
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { anthropicMessage, flattenContent, messagesToPrompt, newId, toAnthropicStop, toSplitUsage } from "../protocol.mjs";
import { clientAbortSignal, rethrowInternal, runPrompt, runStreamPrompt } from "../inference.mjs";

const bodySchema = z.object({
  model: z.string().default("auto"),
  max_tokens: z.number().int().positive().optional(),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.unknown())]),
  })).min(1),
  stream: z.boolean().default(false),
});

export function registerMessagesRoutes(app, { ctx }) {
  app.post("/v1/messages", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    // Anthropic 的 system 是独立字段，与 messages 里的 system 角色合并
    const userSystem = flattenContent(body.system);
    const prompt = messagesToPrompt(body.messages);
    const system = [userSystem, prompt.system].filter(Boolean).join("\n\n");
    if (!prompt.text) throw badRequest("messages 中没有可推理的内容");

    const resolved = await ctx.resolver.resolve(body.model);
    const id = newId("msg_");

    if (!body.stream) {
      try {
        const result = await runPrompt({ ctx, resolved, prompt, system });
        return anthropicMessage({ id, model: result.model, text: result.text, tokens: result.tokens, stopReason: toAnthropicStop(result.finish) });
      } catch (error) {
        rethrowInternal(ctx.logger, error, "messages 推理");
      }
    }

    // —— Anthropic SSE 事件序：message_start → content_block_start → deltas → ……（api.md §6）——
    const sse = startSse(reply);
    const signal = clientAbortSignal(request);
    try {
      sse.send("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: resolved.name,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      sse.send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      const result = await runStreamPrompt({
        ctx,
        resolved,
        prompt,
        system,
        signal,
        onDelta: (delta) => sse.send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        }),
      });
      sse.send("content_block_stop", { type: "content_block_stop", index: 0 });
      sse.send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: toAnthropicStop(result.finish), stop_sequence: null },
        usage: toSplitUsage(result.tokens),
      });
      sse.send("message_stop", { type: "message_stop" });
    } catch (error) {
      if (signal.aborted) {
        ctx.logger.warn({ model: resolved.name }, "客户端断开，推理中止");
      } else {
        // SSE 已开始，状态码不可改：记录日志后直接终止流（api.md §2.4）
        ctx.logger.error({ err: error }, "messages 流式推理失败");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}
