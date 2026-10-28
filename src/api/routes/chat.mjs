// POST /v1/chat/completions: OpenAI Chat Completions with SSE streaming (api.md §4).
import { z } from "zod";
import { badRequest } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { toJsonSchema } from "../openapi.mjs";
import { chatChunk, chatCompletion, messagesToPrompt, newId, toOpenAiFinish } from "../protocol.mjs";
import { clientAbortSignal, rethrowInternal, runPrompt, runStreamPrompt } from "../inference.mjs";
import { logUsage } from "../../core/usage.mjs";

const bodySchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  })).min(1),
  stream: z.boolean().default(false),
  // Sampling parameters: OpenCode does not forward them, so they are logged and ignored (api.md §4)
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.string().optional(),
});

const responseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["chat.completion"] },
    created: { type: "integer" },
    model: { type: "string" },
    choices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          index: { type: "integer" },
          message: {
            type: "object",
            additionalProperties: true,
            properties: {
              role: { type: "string" },
              content: { type: "string" },
            },
          },
          finish_reason: { type: "string" },
        },
      },
    },
    usage: { type: "object", additionalProperties: true },
  },
};

export function registerChatRoutes(app, { ctx }) {
  app.post("/v1/chat/completions", {
    schema: {
      tags: ["chat"],
      summary: "Chat Completions",
      description:
        "OpenAI Chat Completions，纯文本推理。stream=true 时返回 text/event-stream（chat.completion.chunk，结束发 data: [DONE]）。",
      body: toJsonSchema(bodySchema),
      response: { 200: responseSchema },
    },
  }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    const resolved = await ctx.resolver.resolve(body.model);
    const prompt = messagesToPrompt(body.messages);
    const id = newId("chatcmpl-");
    const startedAt = Date.now();

    if (!body.stream) {
      try {
        const result = await runPrompt({ ctx, resolved, prompt, system: prompt.system });
        logUsage(ctx.logger, { endpoint: "/v1/chat/completions", model: result.model, stream: false, startedAt, result });
        return chatCompletion({ id, model: resolved.name, text: result.text, tokens: result.tokens, finishReason: toOpenAiFinish(result.finish) });
      } catch (error) {
        rethrowInternal(ctx.logger, error, "chat inference");
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
      logUsage(ctx.logger, { endpoint: "/v1/chat/completions", model: result.model, stream: true, startedAt, result });
      sse.send(null, chatChunk({ id, model: resolved.name, created, delta: {}, finishReason: toOpenAiFinish(result.finish) }));
      sse.send(null, chatChunk({ id, model: resolved.name, created, delta: {}, tokens: result.tokens }));
      sse.send(null, "[DONE]");
    } catch (error) {
      if (signal.aborted) {
        ctx.logger.warn({ model: resolved.name }, "client disconnected, inference aborted");
      } else {
        // SSE has started, the status code cannot change: log and terminate the stream (api.md §2.4)
        ctx.logger.error({ err: error }, "chat streaming inference failed");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}
