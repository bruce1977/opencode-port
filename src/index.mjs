// Process entry point: assemble config → start Fastify → launch or connect to opencode serve → register routes and hooks → listen.
// design.md §5: component wiring and lifecycle (including graceful shutdown).
import Fastify from "fastify";
import { loadConfig, loadDotEnv } from "./config.mjs";
import { ApiError } from "./core/errors.mjs";
import { createBackendClient } from "./core/opencode-client.mjs";
import { createModelResolver } from "./core/model-resolver.mjs";
import { createServerManager } from "./core/server-manager.mjs";
import { createSessionStore } from "./core/session-store.mjs";
import { writeModelCatalogue } from "./startup-report.mjs";
import { createAuthHook } from "./api/auth.mjs";
import { AJV_OPTIONS } from "./api/fastify-options.mjs";
import { registerOpenApi } from "./api/openapi.mjs";
import { registerHealthRoutes } from "./api/routes/health.mjs";
import { registerModelsRoutes } from "./api/routes/models.mjs";
import { registerAliasesRoutes } from "./api/routes/aliases.mjs";
import { registerChatRoutes } from "./api/routes/chat.mjs";
import { registerResponseRoutes } from "./api/routes/responses.mjs";
import { registerMessagesRoutes } from "./api/routes/messages.mjs";
import { registerWebSearchRoutes } from "./api/routes/web-search.mjs";

async function main() {
  // `npm start` / `npm run dev` load the project root .env by default; real environment variables win (no .env in a container is normal)
  const dotenvLoaded = loadDotEnv();
  const config = loadConfig();

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 20 * 1024 * 1024, // allow base64 images (Anthropic/OpenAI image blocks)
    ajv: AJV_OPTIONS,
  });

  if (dotenvLoaded) app.log.info({ path: ".env" }, "loaded .env");
  // Keys status is reported on every start (path and count only, never the values — AGENTS.md §5):
  // "auth is on but no key was loaded" otherwise looks exactly like a broken gateway
  if (config.apiKeyEnabled) {
    const fields = { keysFile: config.apiKeysFile, keysFileFound: config.apiKeysFileFound, keyCount: config.apiKeys.length };
    if (config.apiKeys.length === 0) {
      app.log.error(fields, "API key auth is enabled but no key was loaded, every request will get 401 (put one plaintext key per line in this file — template: config/.keys.example in the repository — or set API_KEY)");
    } else if (!config.apiKeysFileFound) {
      app.log.warn(fields, "API keys file not found, accepting the API_KEY environment variable only");
    } else {
      app.log.info(fields, "API key auth enabled");
    }
  } else if (!config.apiKeysFileFound) {
    app.log.debug({ keysFile: config.apiKeysFile }, "API key auth disabled and no keys file present");
  }

  const serverManager = createServerManager({ config, logger: app.log });
  const serverUrl = await serverManager.startServe();
  const client = createBackendClient({ baseUrl: serverUrl, password: config.serverPassword });
  const resolver = createModelResolver({ client, config, logger: app.log });
  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMin * 60 * 1000,
    onExpire: (sessionId) => client.deleteSession(sessionId),
  });

  const ctx = { config, client, resolver, sessions, serverManager, logger: app.log };

  // Swagger / OpenAPI must be registered before business routes: the onRoute hook collects endpoint schemas from them
  await registerOpenApi(app, { config });

  // onRequest, not preHandler: Fastify validates the body before preHandler, so an unauthenticated
  // caller would otherwise get a 400 schema error (free feedback about the request contract) instead of 401
  app.addHook("onRequest", createAuthHook({ config }));

  // Unified outward errors: ApiError follows the contract, unknown exceptions never leak stack traces (api.md §2.4 / AGENTS.md §4.3)
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
    request.log.error({ err: error }, "unexpected exception");
    reply.status(500).send({ error: { message: "网关内部错误", type: "server_error", code: "internal_error" } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { message: "未知端点", type: "invalid_request_error", code: "not_found" } });
  });

  registerHealthRoutes(app, { ctx });
  registerModelsRoutes(app, { ctx });
  registerAliasesRoutes(app, { ctx });
  registerChatRoutes(app, { ctx });
  registerResponseRoutes(app, { ctx });
  registerMessagesRoutes(app, { ctx });
  registerWebSearchRoutes(app, { ctx });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  // localProvider is logged because a mismatch with opencode.json / models.allow is the usual reason
  // the custom models are missing from /v1/models
  app.log.info(
    { port: config.port, server: serverUrl, docs: "/docs", localProvider: config.localProvider },
    "gateway started",
  );

  // Fetch the full model catalogue (built-in + custom providers) once after startup and print it to the terminal.
  // Failure does not block startup: /health reports degraded and later requests can still retry.
  try {
    const catalogue = await resolver.listAll();
    writeModelCatalogue(process.stdout, catalogue);
    // A renamed OLLAMA_LOCAL_PROVIDER that no declared model matches is otherwise invisible: the gateway looks
    // healthy, /v1/models just stops listing the custom models.
    if (!catalogue.builtins.some((model) => model.name.toLowerCase().startsWith(config.localProviderPrefix))) {
      app.log.warn(
        { localProvider: config.localProvider, builtins: catalogue.builtins.length },
        `no model uses the local provider prefix (check the providers key in opencode.json and OLLAMA_LOCAL_PROVIDER)`,
      );
    }
  } catch (error) {
    app.log.warn({ err: error }, "failed to list available models (gateway keeps starting)");
  }

  // Graceful shutdown: close the gateway first, then opencode serve (design.md §4.1)
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutdown signal received, starting graceful shutdown");
    try {
      await app.close();
      await serverManager.stopServe();
    } catch (error) {
      app.log.error({ err: error }, "error during graceful shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // Startup failure: app.log may not be wired yet, so write to stderr (never to clients, no leak surface)
  process.stderr.write(`Gateway failed to start: ${error?.message ?? error}\n`);
  process.exit(1);
});
