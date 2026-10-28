// GET /v1/aliases: list the model short-name mappings configured in config.yaml (api.md §10).
// Reflects declared configuration only; whether the target model is currently available is not checked. Aliases still resolve through the normal model resolution rules.
const aliasesResponseSchema = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { type: "string", enum: ["list"] },
    data: {
      type: "array",
      items: {
        type: "object",
        required: ["alias", "model", "source"],
        properties: {
          alias: { type: "string", description: "短名（统一小写，解析时大小写不敏感）" },
          model: { type: "string", description: "别名指向的模型全名（<provider>/<model-id>）" },
          source: {
            type: "string",
            enum: ["models.aliases", "ollama.aliases"],
            description: "声明该别名的配置节点",
          },
        },
      },
    },
  },
};

export function registerAliasesRoutes(app, { ctx }) {
  app.get(
    "/v1/aliases",
    {
      schema: {
        tags: ["models"],
        summary: "模型别名列表",
        description:
          "返回 config.yaml 中配置的短名映射：models.aliases（内置模型）与 ollama.aliases（Ollama 模型），按 alias 升序（api.md §10）。",
        response: { 200: aliasesResponseSchema },
      },
    },
    async () => {
      const data = [
        ...Object.entries(ctx.config.modelAliases).map(([alias, model]) => ({
          alias,
          model,
          source: "models.aliases",
        })),
        ...Object.entries(ctx.config.ollamaAliases).map(([alias, model]) => ({
          alias,
          model,
          source: "ollama.aliases",
        })),
      ].sort((a, b) => a.alias.localeCompare(b.alias) || a.source.localeCompare(b.source));
      return { object: "list", data };
    },
  );
}
