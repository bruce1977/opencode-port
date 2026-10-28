// GET /health: gateway plus OpenCode backend connectivity (api.md §1).
const healthResponseSchema = {
  type: "object",
  required: ["status", "gateway", "opencode", "uptime_sec"],
  properties: {
    status: { type: "string", enum: ["ok", "degraded"] },
    gateway: { type: "string" },
    opencode: {
      type: "object",
      required: ["url", "healthy", "version", "mode"],
      properties: {
        url: { type: "string" },
        healthy: { type: "boolean" },
        version: { anyOf: [{ type: "string" }, { type: "null" }] },
        mode: { type: "string", description: "后端生命周期：复用已有实例或由网关拉起" },
      },
    },
    uptime_sec: { type: "integer", minimum: 0 },
  },
};

export function registerHealthRoutes(app, { ctx }) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "健康检查",
        description:
          "返回网关状态与 OpenCode 后端连通性；后端不可达时 status=degraded。开启 API_KEY 时需携带凭据（自测同样携带）。",
        response: { 200: healthResponseSchema },
      },
    },
    async () => {
      const info = await ctx.client.getServerInfo();
      return {
        status: info ? "ok" : "degraded",
        gateway: "opencode-api-gateway",
        opencode: {
          url: ctx.client.baseUrl,
          healthy: Boolean(info),
          version: info?.version ?? null,
          mode: ctx.serverManager.mode(),
        },
        uptime_sec: Math.floor(process.uptime()),
      };
    },
  );
}
