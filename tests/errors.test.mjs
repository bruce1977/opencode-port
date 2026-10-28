// Upstream error normalization: free quota / rate limit → 429, everything else → 502; ApiError is no longer wrapped as 500 (api.md §2.4).
import assert from "node:assert/strict";
import test from "node:test";
import { promptUpstreamError, upstreamError } from "../src/core/errors.mjs";
import { rethrowInternal } from "../src/api/inference.mjs";

test("promptUpstreamError：free-limit → 429 quota_exceeded", () => {
  const error = promptUpstreamError("provider.free-limit: Free usage limit reached");
  assert.equal(error.status, 429);
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.code, "quota_exceeded");
});

test("promptUpstreamError：普通模型错误 → 502 opencode_unavailable", () => {
  const error = promptUpstreamError("ProviderAuthError: no creds");
  assert.equal(error.status, 502);
  assert.equal(error.type, "upstream_error");
  assert.equal(error.code, "opencode_unavailable");
});

test("rethrowInternal：ApiError 原样透出，未知异常才转 500", () => {
  const logger = { error() {} };
  const apiError = upstreamError("后端不可达");
  assert.throws(() => rethrowInternal(logger, apiError, "chat 推理"), (error) => error === apiError);
  assert.throws(
    () => rethrowInternal(logger, new Error("boom"), "chat 推理"),
    (error) => error.status === 500 && !error.message.includes("boom"),
  );
});
