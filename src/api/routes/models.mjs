// GET /v1/models: OpenAI-compatible model list, including the virtual model auto and Ollama declarations (api.md §3).
import { nowSec } from "../protocol.mjs";

const modelsResponseSchema = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { type: "string", enum: ["list"] },
    data: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "object", "created", "owned_by"],
        properties: {
          id: { type: "string" },
          object: { type: "string", enum: ["model"] },
          created: { type: "integer" },
          owned_by: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

export function registerModelsRoutes(app, { ctx }) {
  app.get(
    "/v1/models",
    {
      schema: {
        tags: ["models"],
        summary: "模型列表",
        description:
          "返回虚拟模型 auto、OpenCode 当前可用的内置/提供商模型，以及已声明的 Ollama 模型（api.md §3）。仅列出命中 config.yaml models.allow 的模型；该配置为空时不过滤。",
        response: { 200: modelsResponseSchema },
      },
    },
    async () => {
      const { auto, builtins, ollama } = await ctx.resolver.listAllowed();
      const created = nowSec();
      const data = [
        { id: auto.id, object: "model", created, owned_by: auto.owned_by, description: auto.description },
        ...builtins.map((model) => ({
          id: model.name,
          object: "model",
          created,
          owned_by: model.providerID,
        })),
        ...ollama.map((model) => ({
          id: model.name,
          object: "model",
          created,
          owned_by: "ollama",
        })),
      ];
      return { object: "list", data };
    },
  );
}
