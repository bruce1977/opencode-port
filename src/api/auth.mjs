// Auth: when API_KEY_ENABLED is on, verify Authorization: Bearer (/v1/messages also accepts x-api-key).
// Accepted keys come from config/.keys (one per line) plus the API_KEY environment variable.
// Note this is a separate credential from OPENCODE_SERVER_PASSWORD (design.md §4.6).
import { timingSafeEqual } from "node:crypto";
import { unauthorized } from "../core/errors.mjs";

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Registered as an `onRequest` hook (not `preHandler`): Fastify runs body validation before preHandler,
 * which would let an unauthenticated caller read the request-contract errors.
 * @returns {import("fastify").onRequestHookHandler}
 */
export function createAuthHook({ config }) {
  const keys = config.apiKeys;
  return function authHook(request, _reply, done) {
    if (!config.apiKeyEnabled) return done();
    // Swagger UI is opened directly by the browser and cannot attach Authorization; /docs only exposes the API structure, so it stays public
    const url = request.url ?? "";
    if (url === "/docs" || url.startsWith("/docs/")) return done();
    const auth = request.headers.authorization ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const apiKey = request.headers["x-api-key"];
    const provided = bearer || (typeof apiKey === "string" ? apiKey : "");
    // An empty set must deny (a misconfigured or unreadable keys file cannot open the gateway)
    if (!provided || !keys.some((key) => safeEqual(provided, key))) {
      done(unauthorized());
      return;
    }
    done();
  };
}
