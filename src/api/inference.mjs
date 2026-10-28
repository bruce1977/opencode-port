// Inference helper: the shared "create session → prompt → clean up" flow behind chat / responses / messages.
// 2.x lifecycle (verified): createSession (with model) → prompt (async submit) → wait (block until done)
// → read the final assistant message and normalize it to { text, finish, tokens, cost, error }.
import { ApiError, internalError, promptUpstreamError } from "../core/errors.mjs";

/**
 * Run one non-streaming inference and return the normalized result plus sessionId.
 * The session is deleted right after use (these endpoints have no continuation semantics), including on failure.
 * @param {object} options
 * @param {{ text: string, files?: Array<{uri: string}> }} options.prompt single prompt segment (history already folded)
 * @param {string} [options.system] system instructions (injected via the instructions entry)
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
 * Run one streaming inference: onDelta receives text deltas and the final result is returned at the end.
 * Aborts the backend session when the client disconnects (AbortSignal semantics, see opencode-client.promptStream).
 * @param {object} options
 * @param {(delta: string) => void} options.onDelta text delta callback
 * @param {AbortSignal} [options.signal] client disconnect signal
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

/** 2.x embeds model-side errors in the assistant message error field (e.g. ProviderAuthError); convert them to the unified upstream error here */
function assertNoUpstreamError(result) {
  if (result?.error) {
    throw promptUpstreamError(result.error);
  }
}

/** Client disconnect signal: the Fastify request fires it when the connection closes */
export function clientAbortSignal(request) {
  const controller = new AbortController();
  request.raw.on("close", () => {
    if (!request.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

/** Unexpected error → internalError with a log line; ApiError passes through untouched (AGENTS.md §4.3). */
export function rethrowInternal(logger, error, action) {
  if (error instanceof ApiError) throw error;
  logger.error({ err: error, action }, "inference failed");
  throw internalError("推理失败，请检查网关日志");
}
