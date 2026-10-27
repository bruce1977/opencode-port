// GET /v1/models：OpenAI 兼容模型列表，含虚拟模型 auto 与 Ollama 声明（api.md §3）。
import { nowSec } from "../protocol.mjs";

export function registerModelsRoutes(app, { ctx }) {
  app.get("/v1/models", async () => {
    const { auto, builtins, ollama } = await ctx.resolver.listAll();
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
  });
}
