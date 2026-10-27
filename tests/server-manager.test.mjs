// 进程管理层单测：TCP 端口探测 + 「端口已监听则直接复用，不 spawn」的启动约定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createServerManager, isPortOpen } from "../src/core/server-manager.mjs";

function createLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    logs,
    logger: {
      info: (fields, message) => logs.info.push({ fields, message }),
      warn: (fields, message) => logs.warn.push({ fields, message }),
      error: (fields, message) => logs.error.push({ fields, message }),
      debug: (fields, message) => logs.debug.push({ fields, message }),
    },
  };
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

test("isPortOpen：监听中的端口为 true，关闭后为 false", async () => {
  const server = createTcpServer();
  const port = await listen(server);
  try {
    assert.equal(await isPortOpen("127.0.0.1", port), true);
  } finally {
    await close(server);
  }
  assert.equal(await isPortOpen("127.0.0.1", port), false);
});

test("startServe：端口已有 OpenCode（/api/info 200）时复用，不 spawn", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.1.4", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  const { logs, logger } = createLogger();
  try {
    const manager = createServerManager({
      config: { serverUrl: "", serverPort: port, serverPassword: "pw" },
      logger,
    });
    const url = await manager.startServe();
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal(manager.mode(), "reused");
    assert.equal(manager.external, false);
    assert.ok(logs.info.some((log) => log.message.includes("复用现有实例")));
    assert.equal(await manager.isHealthy(), true);
  } finally {
    await close(server);
  }
});

test("startServe：端口已监听但 /api/info 非 OpenCode 响应时仍直连，并给出 warn", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(404);
    response.end("not opencode");
  });
  const port = await listen(server);
  const { logs, logger } = createLogger();
  try {
    const manager = createServerManager({
      config: { serverUrl: "", serverPort: port, serverPassword: "" },
      logger,
    });
    const url = await manager.startServe();
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal(manager.mode(), "reused");
    assert.ok(logs.warn.some((log) => log.fields.status === 404));
  } finally {
    await close(server);
  }
});

test("startServe：外部 URL 不 spawn，探测不可达时 warn 但仍返回配置地址", async () => {
  // 先占一个空闲端口再释放，避免依赖固定的 1/9 端口是否被占用
  const probeServer = createTcpServer();
  const closedPort = await listen(probeServer);
  await close(probeServer);

  const { logs, logger } = createLogger();
  const url = `http://127.0.0.1:${closedPort}`;
  const manager = createServerManager({
    config: { serverUrl: url, serverPort: 10001, serverPassword: "" },
    logger,
  });
  assert.equal(manager.external, true);
  assert.equal(await manager.startServe(), url);
  assert.equal(manager.mode(), "external");
  assert.ok(logs.warn.some((log) => log.message.includes("不可达")));
});
