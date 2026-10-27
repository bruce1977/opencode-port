// 鉴权钩子单测：API_KEY_ENABLED 关闭时放行；开启时 Bearer / x-api-key 校验（design.md §4.6）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthHook } from "../src/api/auth.mjs";

function runHook(config, headers) {
  const hook = createAuthHook({ config });
  const request = { headers };
  let error = "called";
  hook(request, {}, (result) => { error = result; });
  return error;
}

const OFF = Object.freeze({ apiKeyEnabled: false, apiKey: "secret-key" });
const ON = Object.freeze({ apiKeyEnabled: true, apiKey: "secret-key" });

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

test("启用 + 缺失 / 错误 / 大小写变体", () => {
  const missing = runHook(ON, {});
  assert.equal(missing.status, 401);
  assert.equal(missing.code, "invalid_api_key");

  const wrong = runHook(ON, { authorization: "Bearer wrong-key" });
  assert.equal(wrong.status, 401);

  // Bearer 大小写不敏感；token 本身大小写敏感
  assert.equal(runHook(ON, { authorization: "bearer secret-key" }), undefined);
  assert.equal(runHook(ON, { authorization: "Bearer SECRET-KEY" }).status, 401);

  // 非 Bearer 前缀（如 Basic）不误放行
  assert.equal(runHook(ON, { authorization: "Basic dXNlcjpwdw==" }).status, 401);

  // Bearer 为空串不放行
  assert.equal(runHook(ON, { authorization: "Bearer " }).status, 401);
});

test("启用 + 错误 key 不同长度：不抛异常直接 401（timingSafeEqual 前置长度检查）", () => {
  assert.equal(runHook(ON, { authorization: "Bearer short" }).status, 401);
  assert.equal(runHook(ON, { "x-api-key": "a-much-longer-key-than-secret" }).status, 401);
});
