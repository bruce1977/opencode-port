// Unified client-facing error shape: { error: { message, type, code } } (api.md §2.4).
// Lives in core so both api and tools can share it (dependency direction api/tools → core).
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message description shown to the client (Chinese contract text)
   * @param {string} type OpenAI-style error type
   * @param {string} code machine-readable error code
   */
  constructor(status, message, type, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = code;
  }

  /** Convert to the client-facing JSON error body */
  toResponse() {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

export const badRequest = (message, code = "invalid_request") =>
  new ApiError(400, message, "invalid_request_error", code);

export const invalidModel = (message) =>
  new ApiError(400, message, "invalid_request_error", "invalid_model");

export const modelNotFound = (message) =>
  new ApiError(400, message, "invalid_request_error", "model_not_found");

export const unauthorized = (message = "缺少或错误的 API KEY") =>
  new ApiError(401, message, "authentication_error", "invalid_api_key");

export const endpointNotFound = (path) =>
  new ApiError(404, `未找到端点 ${path}`, "not_found_error", "endpoint_not_found");

export const upstreamError = (message, code = "opencode_unavailable") =>
  new ApiError(502, message, "upstream_error", code);

// OpenCode free-model quota exhausted (provider.free-limit) and common rate-limit errors → 429 (api.md §2.4)
const QUOTA_PATTERN = /free[- ]limit|rate limit|quota|too many requests|\b429\b/i;

/** Normalize model-side errors: quota/rate limit → 429 quota_exceeded, otherwise → 502 opencode_unavailable */
export const promptUpstreamError = (message) => (QUOTA_PATTERN.test(message)
  ? new ApiError(429, `推理失败：${message}`, "rate_limit_error", "quota_exceeded")
  : upstreamError(`推理失败：${message}`));

export const noAvailableModel = (message) =>
  new ApiError(503, message, "service_unavailable", "no_available_model");

export const internalError = (message = "网关内部错误") =>
  new ApiError(500, message, "api_error", "upstream_error");
