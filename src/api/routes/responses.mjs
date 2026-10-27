// POST /v1/responses：OpenAI Responses API，SSE 流式，支持 previous_response_id 续接（api.md §5）。
// 2.x 续接语义：会话本身保留上下文，续接时用 switchModel 对齐模型（模型绑定在会话上）。
import { z } from "zod";
import { badRequest, upstreamError } from "../../core/errors.mjs";
import { startSse } from "../sse.mjs";
import { inputToMessages, messagesToPrompt, newId, responsesObject } from "../protocol.mjs";
import { clientAbortSignal, runPrompt, runStreamPrompt } from "../inference.mjs";

const bodySchema = z.object({
  model: z.string().default("auto"),
  input: z.union([z.string(), z.array(z.unknown())]),
  stream: z.boolean().default(false),
  previous_response_id: z.string().optional(),
});

export function registerResponseRoutes(app, { ctx }) {
  app.post("/v1/responses", async (request, reply) => {
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

    // 续接：previous_response_id → 已有 OpenCode session；新建则记录映射供下次续接
    const previousId = body.previous_response_id;
    const existingSession = previousId ? ctx.sessions.get(previousId) : null;
    if (previousId && !existingSession) {
      request.log.warn({ previous_response_id: previousId }, "previous_response_id 不存在或已过期，将开启新会话");
    }

    if (!body.stream) {
      const result = await runPromptPreserving({ ctx, resolved, prompt, system: prompt.system, existingSession });
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
        ctx.logger.warn({ model: resolved.name }, "客户端断开，推理中止");
      } else {
        // SSE 已开始，用流内 error 事件表达失败（api.md §2.4）
        send("error", { code: error.code ?? "upstream_error", message: error.message });
        sse.send(null, "[DONE]");
      }
    } finally {
      sse.end();
    }
    return reply;
  });
}

// 续接语义：复用已有 session（会话保留给下一轮），否则新建并保留
async function runPromptPreserving({ ctx, resolved, prompt, system, existingSession }) {
  if (existingSession) {
    await ctx.client.switchModel(existingSession, { providerID: resolved.providerID, id: resolved.modelID });
    const result = await ctx.client.prompt({ sessionId: existingSession, text: prompt.text, files: prompt.files, system });
    if (result.error) throw upstreamError(`推理失败：${result.error}`);
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
    if (result.error) throw upstreamError(`推理失败：${result.error}`);
    return { ...result, model: resolved.name, sessionId: existingSession };
  }
  return runStreamPrompt({ ctx, resolved, prompt, system, signal, onDelta, keepSession: true });
}
