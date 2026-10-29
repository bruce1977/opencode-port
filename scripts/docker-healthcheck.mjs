// Docker HEALTHCHECK entry point: asks the gateway's own GET /health and exits non-zero unless the
// whole chain answers status=ok. Docker (and the container panel) owns health state from here;
// the gateway process itself no longer runs a self-test timer.
// It runs as a separate process, so it reuses loadConfig for the listen port and the key selection
// rather than duplicating the config/.keys parsing. stdout here *is* the health log Docker keeps
// (`docker inspect --format '{{json .State.Health}}'`), which is why it writes directly instead of
// through the gateway's pino logger.
import { loadConfig, loadDotEnv } from "../src/config.mjs";

const REQUEST_TIMEOUT_MS = 8000;

function report(line) {
  process.stdout.write(`${line}\n`);
}

async function check() {
  // Same assembly as the gateway: .env first (absent in a container — silently skipped), real env wins.
  // Without this, a host-side `node scripts/docker-healthcheck.mjs` would probe the default port instead
  // of the one the gateway actually read from .env.
  loadDotEnv();
  const config = loadConfig();
  // /health is guarded like the rest of the API when auth is on; the first accepted key is enough.
  const headers =
    config.apiKeyEnabled && config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const response = await fetch(`http://127.0.0.1:${config.port}/health`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  const backend = body?.opencode ?? {};
  if (response.ok && body?.status === "ok") {
    return {
      ok: true,
      line: `healthy: backend ${backend.version ?? "unknown"} (${backend.mode ?? "unknown"}), uptime ${body.uptime_sec ?? 0}s`,
    };
  }
  return {
    ok: false,
    line: `unhealthy: http ${response.status}, status ${body?.status ?? "invalid_response"}, backend healthy=${backend.healthy ?? "unknown"}`,
  };
}

try {
  const { ok, line } = await check();
  report(line);
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  const reason =
    error?.name === "TimeoutError"
      ? `/health timed out after ${REQUEST_TIMEOUT_MS}ms`
      : // fetch failures surface as "fetch failed"; the real diagnostic (ECONNREFUSED, EAI_AGAIN…) is on cause
      `${error?.message ?? error}${error?.cause?.code ? ` (${error.cause.code})` : ""}`;
  report(`unhealthy: ${reason}`);
  process.exitCode = 1;
}
