// 统一对外错误：{ error: { message, type, code } }（api.md §2.4）。
// 放在 core 层以便 api / tools 共用（依赖方向 api/tools → core）。
export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 对客户端可见的中文描述
   * @param {string} type OpenAI 风格错误 type
   * @param {string} code 机器可读错误码
   */
  constructor(status, message, type, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = code;
  }

  /** 转成对外 JSON 响应体 */
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

export const noAvailableModel = (message) =>
  new ApiError(503, message, "service_unavailable", "no_available_model");

export const internalError = (message = "网关内部错误") =>
  new ApiError(500, message, "api_error", "upstream_error");
