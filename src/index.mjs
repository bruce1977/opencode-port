// 进程入口：装配配置 → 启动 Fastify → 拉起或连接 opencode serve → 注册路由与钩子 → 监听。
// design.md §5：组件装配与生命周期（含优雅退出）。
import Fastify from "fastify";
import { loadConfig, loadDotEnv } from "./config.mjs";
import { ApiError } from "./core/errors.mjs";
import { createBackendClient } from "./core/opencode-client.mjs";
import { createModelResolver } from "./core/model-resolver.mjs";
import { createServerManager } from "./core/server-manager.mjs";
import { createSessionStore } from "./core/session-store.mjs";
import { startHealthSelfTest } from "./core/health-monitor.mjs";
import { writeModelCatalogue } from "./startup-report.mjs";
import { createAuthHook } from "./api/auth.mjs";
import { registerHealthRoutes } from "./api/routes/health.mjs";
import { registerModelsRoutes } from "./api/routes/models.mjs";
import { registerChatRoutes } from "./api/routes/chat.mjs";
import { registerResponseRoutes } from "./api/routes/responses.mjs";
import { registerMessagesRoutes } from "./api/routes/messages.mjs";
import { registerWebSearchRoutes } from "./api/routes/web-search.mjs";

async function main() {
  // `npm start` / `npm run dev` 默认读取项目根 .env；已存在的真实环境变量优先（容器内无 .env 属正常）
  const dotenvLoaded = loadDotEnv();
  const config = loadConfig();

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 20 * 1024 * 1024, // 允许 base64 图片（Anthropic/OpenAI 图像块）
  });

  if (dotenvLoaded) app.log.info({ path: ".env" }, "已加载 .env");

  const serverManager = createServerManager({ config, logger: app.log });
  const serverUrl = await serverManager.startServe();
  const client = createBackendClient({ baseUrl: serverUrl, password: config.serverPassword });
  const resolver = createModelResolver({ client, config, logger: app.log });
  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMin * 60 * 1000,
    onExpire: (sessionId) => client.deleteSession(sessionId),
  });

  const ctx = { config, client, resolver, sessions, serverManager, logger: app.log };

  app.addHook("preHandler", createAuthHook({ config }));

  // 统一对外错误：ApiError 按契约返回，未知异常不泄漏堆栈（api.md §2.4 / AGENTS.md §4.3）
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(error.toResponse());
      return;
    }
    if (error.statusCode === 401) {
      reply.status(401).send({ error: { message: "缺少或错误的 API KEY", type: "invalid_request_error", code: "invalid_api_key" } });
      return;
    }
    if (error.statusCode === 413) {
      reply.status(413).send({ error: { message: "请求体过大", type: "invalid_request_error", code: "payload_too_large" } });
      return;
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      reply.status(error.statusCode).send({ error: { message: error.message, type: "invalid_request_error", code: "invalid_request" } });
      return;
    }
    request.log.error({ err: error }, "未预期异常");
    reply.status(500).send({ error: { message: "网关内部错误", type: "server_error", code: "internal_error" } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { message: "未知端点", type: "invalid_request_error", code: "not_found" } });
  });

  registerHealthRoutes(app, { ctx });
  registerModelsRoutes(app, { ctx });
  registerChatRoutes(app, { ctx });
  registerResponseRoutes(app, { ctx });
  registerMessagesRoutes(app, { ctx });
  registerWebSearchRoutes(app, { ctx });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info({ port: config.port, server: serverUrl }, "网关已启动");

  // 启动后拉取一次完整模型清单（内置 + 自定义 provider）并输出到终端。
  // 失败不阻塞网关启动：/health 会显示 degraded，后续请求仍可重试。
  try {
    const catalogue = await resolver.listAll();
    writeModelCatalogue(process.stdout, catalogue);
  } catch (error) {
    app.log.warn({ err: error }, "拉取可用模型失败（网关继续启动）");
  }

  // 周期性自测：每 60s 调一次自己的 /health（含后端连通性）
  const selfTest = startHealthSelfTest({
    url: `http://127.0.0.1:${config.port}/health`,
    intervalMs: 60 * 1000,
    apiKey: config.apiKeyEnabled ? config.apiKey : "",
    logger: app.log,
  });
  app.log.info({ intervalSec: 60, url: `http://127.0.0.1:${config.port}/health` }, "自测定时器已启动");

  // 优雅退出：先停自测与网关，再停 opencode serve（design.md §4.1）
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "收到退出信号，开始优雅退出");
    try {
      selfTest.stop();
      await app.close();
      await serverManager.stopServe();
    } catch (error) {
      app.log.error({ err: error }, "优雅退出异常");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // 启动失败：此时 app.log 可能未装配，走 stderr（不向客户端输出，无泄漏面）
  process.stderr.write(`网关启动失败：${error?.message ?? error}\n`);
  process.exit(1);
});
