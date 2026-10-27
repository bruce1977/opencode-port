// 会话映射：客户端 conversation/session 概念 ↔ OpenCode session.id，带 TTL 清理（design.md §5.4）。
import { randomBytes } from "node:crypto";

/**
 * @param {object} options
 * @param {number} options.ttlMs 会话存活时间
 * @param {(sessionId: string) => void | Promise<void>} [options.onExpire] 过期时通知后端清理
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
      void Promise.resolve(onExpire?.(hit.sessionId)).catch(() => {});
      return null;
    }
    return hit.sessionId;
  }

  function set(key, sessionId) {
    map.set(key, { sessionId, expiresAt: Date.now() + ttlMs });
  }

  /** 新建一对 (key, sessionId)，或续接已有 key */
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
