// GET /health：网关 + OpenCode 后端连通性（api.md §1）。
export function registerHealthRoutes(app, { ctx }) {
  app.get("/health", async () => {
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
  });
}
