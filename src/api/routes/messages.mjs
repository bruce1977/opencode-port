// POST /v1/messages: Anthropic Messages API (Claude SDK compatible) with SSE streaming (api.md §6).
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { toJsonSchema } from "../openapi.mjs";
import { anthropicMessage, flattenContent, messagesToPrompt, newId, toAnthropicStop, toSplitUsage } from "../protocol.mjs";
import { clientAbortSignal, rethrowInternal, runPrompt, runStreamPrompt } from "../inference.mjs";
import { logUsage } from "../../core/usage.mjs";

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

const responseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["message"] },
    role: { type: "string", enum: ["assistant"] },
    model: { type: "string" },
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          type: { type: "string", enum: ["text"] },
          text: { type: "string" },
        },
      },
    },
    stop_reason: { type: "string" },
    usage: {
      type: "object",
      additionalProperties: true,
      properties: {
        input_tokens: { type: "integer" },
        output_tokens: { type: "integer" },
      },
    },
  },
};

export function registerMessagesRoutes(app, { ctx }) {
  app.post("/v1/messages", {
    schema: {
      tags: ["messages"],
      summary: "Anthropic Messages",
      description:
        "Anthropic Messages API（兼容 Claude SDK，鉴权支持 Bearer 或 x-api-key）。stream=true 时按 message_start → content_block_delta → message_stop 事件序输出 SSE。",
      body: toJsonSchema(bodySchema),
      response: { 200: responseSchema },
    },
  }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    // Anthropic keeps system in its own field; merge it with the system role inside messages
    const userSystem = flattenContent(body.system);
    const prompt = messagesToPrompt(body.messages);
    const system = [userSystem, prompt.system].filter(Boolean).join("\n\n");
    if (!prompt.text) throw badRequest("messages 中没有可推理的内容");

    const resolved = await ctx.resolver.resolve(body.model);
    const id = newId("msg_");
    const startedAt = Date.now();

    if (!body.stream) {
      try {
        const result = await runPrompt({ ctx, resolved, prompt, system });
        logUsage(ctx.logger, { endpoint: "/v1/messages", model: result.model, stream: false, startedAt, result });
        return anthropicMessage({ id, model: result.model, text: result.text, tokens: result.tokens, stopReason: toAnthropicStop(result.finish) });
      } catch (error) {
        rethrowInternal(ctx.logger, error, "messages inference");
      }
    }

    // —— Anthropic SSE event order: message_start → content_block_start → deltas → …… (api.md §6) ——
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
      logUsage(ctx.logger, { endpoint: "/v1/messages", model: result.model, stream: true, startedAt, result });
      sse.send("content_block_stop", { type: "content_block_stop", index: 0 });
      sse.send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: toAnthropicStop(result.finish), stop_sequence: null },
        usage: toSplitUsage(result.tokens),
      });
      sse.send("message_stop", { type: "message_stop" });
    } catch (error) {
      if (signal.aborted) {
        ctx.logger.warn({ model: resolved.name }, "client disconnected, inference aborted");
      } else {
        // SSE has started, the status code cannot change: log and terminate the stream (api.md §2.4)
        ctx.logger.error({ err: error }, "messages streaming inference failed");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}
