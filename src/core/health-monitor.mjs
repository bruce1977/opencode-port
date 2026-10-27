// 运行期自测：周期性调用网关自己的 GET /health，确认「网关 → opencode serve」链路仍然通。
// 只做观测，不负责重启后端（子进程退出的重启由 server-manager 负责，design.md §5.1）。
const DEFAULT_INTERVAL_MS = 60000;
const SELF_TEST_TIMEOUT_MS = 10000;

/**
 * 启动周期性 /health 自测。
 * @param {object} options
 * @param {string} options.url 网关 /health 地址（如 http://127.0.0.1:10000/health）
 * @param {number} [options.intervalMs] 间隔，默认 60s
 * @param {string} [options.apiKey] API_KEY_ENABLED 开启时的 Bearer key（/health 也在鉴权后）
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {typeof globalThis.fetch} [options.fetch] 注入用（测试传假 fetch）
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
        logger.warn({ status: response.status, latencyMs, consecutiveFailures }, "自测未通过：/health 返回非 2xx");
        return;
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        // /health 响应不是 JSON：下面按 degraded 处理，不因解析失败中断定时器
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
          "自测通过：/health",
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
        "自测未通过：后端不健康",
      );
    } catch (error) {
      if (stopped) return; // stop() 主动中止：不是失败
      consecutiveFailures += 1;
      logger.warn({ err: error, consecutiveFailures }, "自测失败：/health 请求异常");
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
