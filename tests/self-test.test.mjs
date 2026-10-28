// Self-test timer unit tests: success/failure logging, Bearer header, no calls after stop (no real ports needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHealthSelfTest } from "../src/core/health-monitor.mjs";

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待条件超时");
    await delay(5);
  }
}

function createLogger() {
  const logs = { info: [], warn: [] };
  return {
    logs,
    logger: {
      info: (fields, message) => logs.info.push({ fields, message }),
      warn: (fields, message) => logs.warn.push({ fields, message }),
    },
  };
}

test("自测成功：带 Bearer 头，记录 status/version，stop 后不再调度", async () => {
  const { logs, logger } = createLogger();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({
      status: "ok",
      opencode: { healthy: true, version: "2.2.0" },
      uptime_sec: 1,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const monitor = startHealthSelfTest({
    url: "http://127.0.0.1:10000/health",
    intervalMs: 10,
    apiKey: "secret",
    logger,
    fetch: fetchImpl,
  });
  try {
    await waitFor(() => calls.length >= 2);
    assert.equal(calls[0].url, "http://127.0.0.1:10000/health");
    assert.equal(calls[0].auth, "Bearer secret");
    assert.ok(logs.info.length >= 1);
    assert.equal(logs.info[0].fields.backendVersion, "2.2.0");
    assert.equal(logs.warn.length, 0);
  } finally {
    monitor.stop();
  }
  const stoppedAt = calls.length;
  await delay(40);
  assert.equal(calls.length, stoppedAt, "stop() 后不应再发起自测");
});

test("自测未通过：非 2xx、degraded、请求异常都记 warn 并累计失败次数", async () => {
  const { logs, logger } = createLogger();
  const responses = [
    async () => new Response("nope", { status: 500 }),
    async () => new Response(JSON.stringify({ status: "degraded", opencode: { healthy: false } }), { status: 200 }),
    async () => { throw new Error("ECONNREFUSED"); },
  ];
  let index = 0;
  const monitor = startHealthSelfTest({
    url: "http://127.0.0.1:10000/health",
    intervalMs: 5,
    logger,
    fetch: async () => responses[Math.min(index++, responses.length - 1)](),
  });
  try {
    await waitFor(() => logs.warn.length >= 3);
  } finally {
    monitor.stop();
  }
  assert.equal(logs.warn[0].fields.status, 500);
  assert.equal(logs.warn[1].fields.status, "degraded");
  assert.equal(logs.warn[2].fields.consecutiveFailures, 3);
  assert.equal(logs.info.length, 0);
});
