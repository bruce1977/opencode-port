// Swagger / OpenAPI: aggregate the route schemas into an OpenAPI 3.1 document and serve an interactive UI at /docs.
// Request body JSON Schemas are generated from the zod schemas already defined in the routes (zod stays the validation source of truth, avoiding two drifting definitions).
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import { APP_VERSION } from "../version.mjs";

const TAGS = [
  { name: "health", description: "网关与 OpenCode 后端健康状态" },
  { name: "models", description: "OpenAI 兼容模型列表（含虚拟模型 auto）" },
  { name: "chat", description: "OpenAI Chat Completions（支持 SSE）" },
  { name: "responses", description: "OpenAI Responses API（支持 SSE 与会话续接）" },
  { name: "messages", description: "Anthropic Messages API（兼容 Claude SDK）" },
  { name: "web-search", description: "独立 web-search API（需指定内置模型）" },
];

const DESCRIPTION = [
  "把 opencode serve 的内置免费模型与能力封装为 OpenAI / Anthropic 兼容 API 的网关。",
  "字段契约以 docs/api.md 为准；本页由各路由 schema 生成。",
  "stream=true 的推理端点返回 text/event-stream：OpenAI 系以 data: [DONE] 结束，Anthropic 以 message_stop 结束。",
].join("\n\n");

/** zod schema → JSON Schema attachable to a Fastify route (drops the $schema zod adds) */
export function toJsonSchema(schema) {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" });
  return jsonSchema;
}

/**
 * Register the OpenAPI document and Swagger UI.
 * Must be called before the business routes: @fastify/swagger collects route schemas through the onRoute hook.
 * @param {import("fastify").FastifyInstance} app
 * @param {{ config: { port: number, apiKeyEnabled: boolean } }} options
 */
export async function registerOpenApi(app, { config }) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "OpenCode API Gateway",
        version: APP_VERSION,
        description: DESCRIPTION,
      },
      // Use a relative URL so Swagger UI sends requests against the origin serving the document:
      // hardcoding http://127.0.0.1 turns access from localhost / a LAN IP / a reverse proxy into a cross-origin request (no CORS headers) and ends in Failed to fetch
      servers: [{ url: "/", description: "当前网关（同源）" }],
      tags: TAGS,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "API_KEY_ENABLED=true 时必填；填 config/.keys 里任意一行（或 API_KEY 环境变量的值）。/v1/messages 也接受 x-api-key",
          },
          anthropicApiKey: {
            type: "apiKey",
            in: "header",
            name: "x-api-key",
            description: "Claude SDK 风格鉴权，可替代 Bearer",
          },
        },
      },
      ...(config.apiKeyEnabled
        ? { security: [{ bearerAuth: [] }, { anthropicApiKey: [] }] }
        : {}),
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      filter: true,
      persistAuthorization: true,
    },
  });
}
