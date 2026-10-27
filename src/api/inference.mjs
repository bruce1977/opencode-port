// 推理执行辅助：chat / responses / messages 三个端点共用的「建会话 → prompt → 清理」流程。
// 2.x 生命周期（已实测）：createSession（带 model）→ prompt（异步投递）→ wait（阻塞等完成）
// → 读最终助手消息归一化为 { text, finish, tokens, cost, error }。
import { internalError, upstreamError } from "../core/errors.mjs";

/**
 * 执行一次非流式推理，返回归一化结果 + sessionId。
 * 会用完即删会话（无续接语义的端点），失败也会清理。
 * @param {object} options
 * @param {{ text: string, files?: Array<{uri: string}> }} options.prompt 单段提示（历史已折叠）
 * @param {string} [options.system] system 指令（经 instructions entry 注入）
 */
export async function runPrompt({ ctx, resolved, prompt, system, keepSession = false }) {
  const session = await ctx.client.createSession({
    model: { providerID: resolved.providerID, id: resolved.modelID },
  });
  try {
    const result = await ctx.client.prompt({
      sessionId: session.id,
      text: prompt.text,
      files: prompt.files,
      system,
    });
    assertNoUpstreamError(result);
    return { ...result, model: resolved.name, sessionId: session.id };
  } finally {
    if (!keepSession) await ctx.client.deleteSession(session.id);
  }
}

/**
 * 执行一次流式推理：onDelta 收到文本增量，结束时返回最终结果。
 * 客户端断开时中止后端会话（AbortSignal 语义见 opencode-client.promptStream）。
 * @param {object} options
 * @param {(delta: string) => void} options.onDelta 文本增量回调
 * @param {AbortSignal} [options.signal] 客户端断开信号
 */
export async function runStreamPrompt({ ctx, resolved, prompt, system, onDelta, signal, keepSession = false }) {
  const session = await ctx.client.createSession({
    model: { providerID: resolved.providerID, id: resolved.modelID },
  });
  try {
    const result = await ctx.client.promptStream({
      sessionId: session.id,
      text: prompt.text,
      files: prompt.files,
      system,
      onDelta,
      signal,
    });
    assertNoUpstreamError(result);
    return { ...result, model: resolved.name, sessionId: session.id };
  } finally {
    if (!keepSession) await ctx.client.deleteSession(session.id);
  }
}

/** 2.x 会把模型侧错误内嵌在助手消息的 error 字段里（如 ProviderAuthError），这里转成统一上游错误 */
function assertNoUpstreamError(result) {
  if (result?.error) {
    throw upstreamError(`推理失败：${result.error}`);
  }
}

/** 客户端断开信号：Fastify request 在连接关闭时触发 */
export function clientAbortSignal(request) {
  const controller = new AbortController();
  request.raw.on("close", () => {
    if (!request.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

/** 未预期异常 → internalError（带日志），避免泄漏堆栈（AGENTS.md §4.3） */
export function rethrowInternal(logger, error, action) {
  logger.error({ err: error }, `${action}失败`);
  throw internalError(`${action}失败，请检查网关日志`);
}
