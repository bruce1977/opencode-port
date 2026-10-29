// Health check script contract: the exit code is what Docker reads, so the cases that matter are
// "200 + status=ok" (healthy) versus everything else — 200 + degraded, a non-2xx, and an unreachable port.
// Runs the script as its own process against a stub server (same shape Docker uses), never the real gateway.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/docker-healthcheck.mjs", import.meta.url));

/** Run the health check against `port` and collect its exit code + stdout. */
async function runHealthCheck(env) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, API_KEY_ENABLED: "false", API_KEY: "", API_KEYS_FILE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, stdout: stdout.trim() };
}

/** A /health stub answering with a fixed status code and body. */
async function serveStub({ statusCode, body, assertRequest }) {
  const server = createServer((req, res) => {
    assertRequest?.(req);
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

test("status=ok 时退出 0，并打印后端版本与运行时长", async () => {
  const { server, port } = await serveStub({
    statusCode: 200,
    body: { status: "ok", opencode: { healthy: true, version: "2.2.0", mode: "spawned" }, uptime_sec: 42 },
  });
  try {
    const { code, stdout } = await runHealthCheck({ PORT: String(port) });
    assert.equal(code, 0);
    assert.match(stdout, /^healthy: backend 2\.2\.0 \(spawned\), uptime 42s$/);
  } finally {
    server.close();
  }
});

test("后端不可达时 /health 仍是 200：按 status=degraded 判为不健康（只看状态码会漏）", async () => {
  const { server, port } = await serveStub({
    statusCode: 200,
    body: { status: "degraded", opencode: { url: "http://127.0.0.1:1", healthy: false, version: null, mode: "spawned" }, uptime_sec: 7 },
  });
  try {
    const { code, stdout } = await runHealthCheck({ PORT: String(port) });
    assert.equal(code, 1);
    assert.match(stdout, /^unhealthy: http 200, status degraded, backend healthy=false$/);
  } finally {
    server.close();
  }
});

test("鉴权开启时携带配置里的 Bearer key；被拒（401）判为不健康", async () => {
  let seenHeader = null;
  const { server, port } = await serveStub({
    statusCode: 401,
    body: { error: { message: "no key", type: "authentication_error", code: "invalid_api_key" } },
    assertRequest: (req) => {
      seenHeader = req.headers.authorization ?? null;
    },
  });
  try {
    const { code, stdout } = await runHealthCheck({
      PORT: String(port),
      API_KEY_ENABLED: "true",
      API_KEY: "sk-probe",
    });
    assert.equal(code, 1);
    assert.match(stdout, /^unhealthy: http 401, status/);
    assert.equal(seenHeader, "Bearer sk-probe");
  } finally {
    server.close();
  }
});

test("网关没在监听：退出 1 并给出可诊断的原因", async () => {
  // Bind then close a port so the number is almost certainly free, then probe it.
  const { server, port } = await serveStub({ statusCode: 200, body: { status: "ok" } });
  server.close();
  await once(server, "close");
  const { code, stdout } = await runHealthCheck({ PORT: String(port) });
  assert.equal(code, 1);
  assert.match(stdout, /^unhealthy: fetch failed/);
});
