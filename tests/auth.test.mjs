// Auth hook unit tests: everything passes when API_KEY_ENABLED is off; Bearer / x-api-key is checked against
// the accepted key set (config/.keys + API_KEY) when it is on (design.md §4.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthHook } from "../src/api/auth.mjs";

function runHook(config, headers, url = "/v1/models") {
  const hook = createAuthHook({ config });
  const request = { headers, url };
  let error = "called";
  hook(request, {}, (result) => { error = result; });
  return error;
}

const OFF = Object.freeze({ apiKeyEnabled: false, apiKeys: ["secret-key", "other-key"] });
const ON = Object.freeze({ apiKeyEnabled: true, apiKeys: ["secret-key", "other-key"] });

test("未启用：任何请求放行", () => {
  assert.equal(runHook(OFF, {}), undefined);
  assert.equal(runHook(OFF, { authorization: "Bearer wrong" }), undefined);
});

test("启用 + 正确 Bearer：放行", () => {
  assert.equal(runHook(ON, { authorization: "Bearer secret-key" }), undefined);
});

test("启用 + 正确 x-api-key（/v1/messages 的 Claude SDK 形式）：放行", () => {
  assert.equal(runHook(ON, { "x-api-key": "secret-key" }), undefined);
});

test("启用 + 多 key：文件里任意一行都可用", () => {
  assert.equal(runHook(ON, { authorization: "Bearer other-key" }), undefined);
  assert.equal(runHook(ON, { "x-api-key": "other-key" }), undefined);
});

test("启用 + 缺失 / 错误 / 大小写变体", () => {
  const missing = runHook(ON, {});
  assert.equal(missing.status, 401);
  assert.equal(missing.code, "invalid_api_key");

  const wrong = runHook(ON, { authorization: "Bearer wrong-key" });
  assert.equal(wrong.status, 401);

  // The Bearer prefix is case-insensitive; the token itself is case-sensitive
  assert.equal(runHook(ON, { authorization: "bearer secret-key" }), undefined);
  assert.equal(runHook(ON, { authorization: "Bearer SECRET-KEY" }).status, 401);

  // A non-Bearer prefix (e.g. Basic) must not be let through
  assert.equal(runHook(ON, { authorization: "Basic dXNlcjpwdw==" }).status, 401);

  // An empty Bearer value must not pass
  assert.equal(runHook(ON, { authorization: "Bearer " }).status, 401);
});

test("启用 + 错误 key 不同长度：不抛异常直接 401（timingSafeEqual 前置长度检查）", () => {
  assert.equal(runHook(ON, { authorization: "Bearer short" }).status, 401);
  assert.equal(runHook(ON, { "x-api-key": "a-much-longer-key-than-secret" }).status, 401);
});

test("启用但一个 key 都没有：全部拒绝（空清单不得变成放行）", () => {
  const none = Object.freeze({ apiKeyEnabled: true, apiKeys: [] });
  assert.equal(runHook(none, { authorization: "Bearer anything" }).status, 401);
  assert.equal(runHook(none, {}).status, 401);
});

test("启用时 /docs 与静态资源公开（浏览器无法附加 Authorization）", () => {
  assert.equal(runHook(ON, {}, "/docs"), undefined);
  assert.equal(runHook(ON, {}, "/docs/"), undefined);
  assert.equal(runHook(ON, {}, "/docs/json"), undefined);
  assert.equal(runHook(ON, {}, "/docs/static/swagger-ui.css"), undefined);
  assert.equal(runHook(ON, {}, "/docsx").status, 401);
});
