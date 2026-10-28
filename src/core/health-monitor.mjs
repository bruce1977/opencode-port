// Runtime self-test: periodically calls the gateway's own GET /health to confirm the
// "gateway → opencode serve" chain is still working.
// Observation only; it never restarts the backend (server-manager owns subprocess restarts, design.md §5.1).
const DEFAULT_INTERVAL_MS = 60000;
const SELF_TEST_TIMEOUT_MS = 10000;

/**
 * Start the periodic /health self-test.
 * @param {object} options
 * @param {string} options.url gateway /health URL (e.g. http://127.0.0.1:10000/health)
 * @param {number} [options.intervalMs] interval, default 60s
 * @param {string} [options.apiKey] Bearer key when API_KEY_ENABLED is on (/health is also guarded)
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {typeof globalThis.fetch} [options.fetch] injection for tests (fake fetch)
 * @returns {{ stop: () => void }}
 */
export function startHealthSelfTest({
  url,
  intervalMs = DEFAULT_INTERVAL_MS,
  apiKey = "",
  logger,
  fetch: fetchImpl = globalThis.fetch,
}) {
  let stopped = false;
  let timer = null;
  let activeController = null;
  let consecutiveFailures = 0;

  async function tick() {
    if (stopped) return;
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), SELF_TEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        consecutiveFailures += 1;
        logger.warn({ status: response.status, latencyMs, consecutiveFailures }, "self-test failed: /health returned non-2xx");
        return;
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        // /health body is not JSON: handled as degraded below, parsing failure must not kill the timer
      }

      if (body?.status === "ok") {
        consecutiveFailures = 0;
        logger.info(
          {
            status: body.status,
            backendHealthy: body.opencode?.healthy ?? null,
            backendVersion: body.opencode?.version ?? null,
            latencyMs,
          },
          "self-test passed: /health",
        );
        return;
      }

      consecutiveFailures += 1;
      logger.warn(
        {
          status: body?.status ?? "invalid_response",
          backend: body?.opencode ?? null,
          latencyMs,
          consecutiveFailures,
        },
        "self-test failed: backend unhealthy",
      );
    } catch (error) {
      if (stopped) return; // aborted by stop(): not a failure
      consecutiveFailures += 1;
      logger.warn({ err: error, consecutiveFailures }, "self-test failed: /health request error");
    } finally {
      clearTimeout(timeout);
      activeController = null;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      activeController?.abort();
    },
  };
}
