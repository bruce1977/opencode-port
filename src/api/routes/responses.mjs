// POST /v1/responses: OpenAI Responses API with SSE streaming and previous_response_id continuation (api.md §5).
// 2.x continuation semantics: the session itself keeps the context; on continuation switchModel aligns the model (the model is bound to the session).
import { z } from "zod";
import { badRequest, promptUpstreamError } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { toJsonSchema } from "../openapi.mjs";
import { inputToMessages, messagesToPrompt, newId, responsesObject } from "../protocol.mjs";
import { clientAbortSignal, runPrompt, runStreamPrompt } from "../inference.mjs";
import { logUsage } from "../../core/usage.mjs";

const bodySchema = z.object({
  model: z.string().default("auto"),
  input: z.union([z.string(), z.array(z.unknown())]),
  stream: z.boolean().default(false),
  previous_response_id: z.string().optional(),
});

const responseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["response"] },
    created_at: { type: "integer" },
    model: { type: "string" },
    status: { type: "string" },
    output: { type: "array", items: { type: "object", additionalProperties: true } },
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

export function registerResponseRoutes(app, { ctx }) {
  app.post("/v1/responses", {
    schema: {
      tags: ["responses"],
      summary: "Responses API",
      description:
        "OpenAI Responses API。stream=true 时按 response.created → output_text.delta → response.completed 事件序输出 SSE；previous_response_id 可续接会话。",
      body: toJsonSchema(bodySchema),
      response: { 200: responseSchema },
    },
  }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(`请求体不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    const messages = inputToMessages(body.input);
    const prompt = messagesToPrompt(messages);
    if (!prompt.text) throw badRequest("input 中没有可推理的内容");

    const resolved = await ctx.resolver.resolve(body.model);
    const id = newId("resp_");
    const startedAt = Date.now();

    // Continuation: previous_response_id → an existing OpenCode session; a freshly created one is recorded for the next continuation
    const previousId = body.previous_response_id;
    const existingSession = previousId ? ctx.sessions.get(previousId) : null;
    if (previousId && !existingSession) {
      request.log.warn({ previous_response_id: previousId }, "previous_response_id not found or expired, starting a new session");
    }

    if (!body.stream) {
      const result = await runPromptPreserving({ ctx, resolved, prompt, system: prompt.system, existingSession });
      logUsage(ctx.logger, { endpoint: "/v1/responses", model: result.model, stream: false, startedAt, result });
      ctx.sessions.link(id, result.sessionId);
      return responsesObject({ id, model: result.model, text: result.text, tokens: result.tokens });
    }

    const sse = startSse(reply);
    const signal = clientAbortSignal(request);
    const send = (type, payload) => sse.send(null, { type, ...payload });
    const baseResponse = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: resolved.name };
    const msgId = newId("msg_");
    try {
      send("response.created", { response: { ...baseResponse, status: "in_progress", output: [] } });
      send("response.in_progress", { response: { ...baseResponse, status: "in_progress", output: [] } });
      send("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
      });
      send("response.content_part.added", {
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      const result = await runStreamPromptPreserving({
        ctx,
        resolved,
        prompt,
        system: prompt.system,
        existingSession,
        signal,
        onDelta: (delta) => send("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta }),
      });
      logUsage(ctx.logger, { endpoint: "/v1/responses", model: result.model, stream: true, startedAt, result });
      ctx.sessions.link(id, result.sessionId);
      send("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: result.text });
      send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: msgId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: result.text, annotations: [] }],
        },
      });
      send("response.completed", {
        response: responsesObject({ id, model: result.model, text: result.text, tokens: result.tokens }),
      });
      sse.send(null, "[DONE]");
    } catch (error) {
      if (signal.aborted) {
        ctx.logger.warn({ model: resolved.name }, "client disconnected, inference aborted");
      } else {
        // SSE has started; express the failure as an in-stream error event (api.md §2.4)
        send("error", { code: error.code ?? "upstream_error", message: error.message });
        sse.send(null, "[DONE]");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}

// Continuation semantics: reuse the existing session (kept for the next turn), otherwise create one and keep it
async function runPromptPreserving({ ctx, resolved, prompt, system, existingSession }) {
  if (existingSession) {
    await ctx.client.switchModel(existingSession, { providerID: resolved.providerID, id: resolved.modelID });
    const result = await ctx.client.prompt({ sessionId: existingSession, text: prompt.text, files: prompt.files, system });
    if (result.error) throw promptUpstreamError(result.error);
    return { ...result, model: resolved.name, sessionId: existingSession };
  }
  return runPrompt({ ctx, resolved, prompt, system, keepSession: true });
}

async function runStreamPromptPreserving({ ctx, resolved, prompt, system, existingSession, signal, onDelta }) {
  if (existingSession) {
    await ctx.client.switchModel(existingSession, { providerID: resolved.providerID, id: resolved.modelID });
    const result = await ctx.client.promptStream({
      sessionId: existingSession,
      text: prompt.text,
      files: prompt.files,
      system,
      onDelta,
      signal,
    });
    if (result.error) throw promptUpstreamError(result.error);
    return { ...result, model: resolved.name, sessionId: existingSession };
  }
  return runStreamPrompt({ ctx, resolved, prompt, system, signal, onDelta, keepSession: true });
}
