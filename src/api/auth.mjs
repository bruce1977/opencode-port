// 鉴权：API_KEY_ENABLED 开启时校验 Authorization: Bearer（/v1/messages 额外接受 x-api-key）。
// 注意与 OPENCODE_SERVER_PASSWORD 是两套独立凭据（design.md §4.6）。
import { timingSafeEqual } from "node:crypto";
import { unauthorized } from "../core/errors.mjs";

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * @returns {import("fastify").preHandlerHookHandler}
 */
export function createAuthHook({ config }) {
  return function authHook(request, _reply, done) {
    if (!config.apiKeyEnabled) return done();
    const auth = request.headers.authorization ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const apiKey = request.headers["x-api-key"];
    const provided = bearer || (typeof apiKey === "string" ? apiKey : "");
    if (!provided || !safeEqual(provided, config.apiKey)) {
      done(unauthorized());
      return;
    }
    done();
  };
}
