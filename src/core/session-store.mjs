// Session mapping: client conversation/session concepts <-> OpenCode session.id, with TTL cleanup (design.md §5.4).
import { randomBytes } from "node:crypto";

/**
 * @param {object} options
 * @param {number} options.ttlMs session time-to-live
 * @param {(sessionId: string) => void | Promise<void>} [options.onExpire] notified on expiry so the backend session can be cleaned up
 */
export function createSessionStore({ ttlMs, onExpire }) {
  /** @type {Map<string, { sessionId: string, expiresAt: number }>} */
  const map = new Map();

  function newKey(prefix = "resp") {
    return `${prefix}_${randomBytes(12).toString("hex")}`;
  }

  function get(key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      map.delete(key);
      // expiry cleanup is best-effort: a failed backend delete must not break the lookup
      void Promise.resolve(onExpire?.(hit.sessionId)).catch(() => {});
      return null;
    }
    return hit.sessionId;
  }

  function set(key, sessionId) {
    map.set(key, { sessionId, expiresAt: Date.now() + ttlMs });
  }

  /** Create a new (key, sessionId) pair, or continue an existing key */
  function link(key, sessionId) {
    const effective = key ?? newKey();
    set(effective, sessionId);
    return effective;
  }

  function sweep() {
    const now = Date.now();
    for (const [key, hit] of map) {
      if (hit.expiresAt <= now) {
        map.delete(key);
        // expiry cleanup is best-effort: a failed backend delete must not abort the sweep
        void Promise.resolve(onExpire?.(hit.sessionId)).catch(() => {});
      }
    }
  }

  const timer = setInterval(sweep, Math.max(ttlMs, 60000));
  timer.unref?.();

  function stop() {
    clearInterval(timer);
    map.clear();
  }

  return { newKey, get, set, link, stop, get size() { return map.size; } };
}
