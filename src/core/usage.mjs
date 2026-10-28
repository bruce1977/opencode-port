// Structured token/cost logging for completed inference.
// OpenCode usage shape: { input, output, reasoning, cache: { read, write } }.
// `input` is the uncached part; `cache.read` is the cached prefix (harness/history).
export function logUsage(logger, { endpoint, model, stream = false, startedAt, result }) {
  const tokens = result?.tokens ?? {};
  const promptTokens = (tokens.input ?? 0) + (tokens.cache?.read ?? 0);
  const completionTokens = tokens.output ?? 0;
  logger.info({
    event: "usage",
    endpoint,
    model,
    stream,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    reasoning_tokens: tokens.reasoning ?? 0,
    cache_read: tokens.cache?.read ?? 0,
    cache_write: tokens.cache?.write ?? 0,
    cost: result?.cost ?? 0,
    duration_ms: Date.now() - startedAt,
  }, "inference usage");
}
