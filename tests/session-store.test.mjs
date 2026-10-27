// 会话映射存储单测：link/get/TTL 过期与 onExpire 通知（design.md §5.4）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../src/core/session-store.mjs";

test("link：无 key 自动生成，有 key 则覆盖续接", () => {
  const store = createSessionStore({ ttlMs: 60000 });
  try {
    const generated = store.link(null, "ses_a");
    assert.match(generated, /^resp_[0-9a-f]{24}$/);
    assert.equal(store.get(generated), "ses_a");

    const named = store.link("resp_custom", "ses_b");
    assert.equal(named, "resp_custom");
    assert.equal(store.get("resp_custom"), "ses_b");
    // 续接：同 key 换 session
    store.link("resp_custom", "ses_c");
    assert.equal(store.get("resp_custom"), "ses_c");
  } finally {
    store.stop();
  }
});

test("get：未知 key 返回 null", () => {
  const store = createSessionStore({ ttlMs: 60000 });
  try {
    assert.equal(store.get("resp_missing"), null);
  } finally {
    store.stop();
  }
});

test("TTL 过期：get 触发 onExpire 并返回 null", async () => {
  const expired = [];
  const store = createSessionStore({ ttlMs: -1, onExpire: (id) => expired.push(id) });
  try {
    store.link("resp_x", "ses_x");
    assert.equal(store.get("resp_x"), null);
    assert.deepEqual(expired, ["ses_x"]);
    // 过期后条目已被删除，重复 get 不再触发 onExpire
    assert.equal(store.get("resp_x"), null);
    assert.equal(expired.length, 1);
  } finally {
    store.stop();
  }
});

test("set/get 直接配对；size 反映条目数；stop 清空", () => {
  const store = createSessionStore({ ttlMs: 60000 });
  store.set("k1", "s1");
  store.set("k2", "s2");
  assert.equal(store.size, 2);
  assert.equal(store.get("k1"), "s1");
  store.stop();
  assert.equal(store.size, 0);
});

test("newKey：前缀可定制且唯一", () => {
  const store = createSessionStore({ ttlMs: 60000 });
  try {
    const a = store.newKey("conv");
    const b = store.newKey("conv");
    assert.match(a, /^conv_[0-9a-f]{24}$/);
    assert.notEqual(a, b);
  } finally {
    store.stop();
  }
});
