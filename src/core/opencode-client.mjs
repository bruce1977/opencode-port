// SDK 适配层：封装 @opencode/client（2.x Promise 客户端，版本与 @opencode/cli 锁定一致），
// 向上层提供归一化接口并统一错误（design.md §5.2）。
// 注意：SDK 与 opencode serve 版本必须一致，升级时两边同步（AGENTS.md §6）。
//
// 2.x 与 1.x 的关键差异（迁移依据，已实测）：
// - 客户端工厂为 OpenCode.make({ baseUrl, headers, fetch? })，失败以 Error 抛出（name=_tag 或 ClientError）；
// - 健康探测走 GET /api/info（返回 { version, pid, urls, paths }）；
// - 模型是一等公民：model.list() 直接返回 ModelInfo[]（不再嵌在 provider 里）；
// - session.prompt 为异步投递（返回 inbox 回执），需 session.wait() 等待执行结束；
// - 无 per-prompt system：改用 session.instructions.entry.put({ key, value }) 注入；
// - 流式增量为独立事件 session.text.delta（data.delta），session.text.ended 带权威全文可对账；
// - 助手结果消息为 content:[{type:text|reasoning|tool}] + finish（OpenAI 风格枚举）+ tokens + cost。
import { OpenCode } from "@opencode/client";
import { upstreamError } from "./errors.mjs";

const PROMPT_TIMEOUT_MS = 300000; // 单次推理最长 5 分钟（agent 任务可能较慢）
const HEALTH_TIMEOUT_MS = 5000;
const MODEL_LIST_TIMEOUT_MS = 15000;

/**
 * @param {object} options
 * @param {string} options.baseUrl opencode serve 地址
 * @param {string} options.password OPENCODE_SERVER_PASSWORD（HTTP Basic，用户名固定 opencode）
 * @param {typeof globalThis.fetch} [options.fetch] 注入用（测试传假 fetch）
 */
export function createBackendClient({ baseUrl, password, fetch: fetchImpl }) {
  const headers = {};
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }
  const client = OpenCode.make(fetchImpl ? { baseUrl, headers, fetch: fetchImpl } : { baseUrl, headers });

  /** 2.x 失败统一为 Error：业务错误 name 为 _tag（如 UnauthorizedError），传输错误为 ClientError */
  function fail(action, error) {
    const detail = error?.message ?? String(error);
    throw upstreamError(`${action}失败：${detail}`);
  }

  /** 健康探测：成功返回 ServerInfo（{version,pid,urls,paths}），失败返回 null */
  async function getServerInfo() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const info = await client.server.info({ signal: controller.signal });
      return info?.version ? info : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function health() {
    return Boolean(await getServerInfo());
  }

  /** 模型列表（含内置免费模型与已配置 provider 的模型，已禁用/废弃的剔除在 resolver 做） */
  async function listModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
      const out = await client.model.list(undefined, { signal: controller.signal });
      return out?.data ?? [];
    } catch (error) {
      if (controller.signal.aborted) {
        throw upstreamError(`读取模型列表超时（>${MODEL_LIST_TIMEOUT_MS / 1000}s）`);
      }
      fail("读取模型列表", error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 服务端 websearch 后端目录（exa/tavily/...，api.md §9） */
  async function listWebSearchProviders() {
    try {
      const out = await client.websearch.providers();
      return out?.data ?? [];
    } catch (error) {
      fail("读取 websearch 后端", error);
    }
  }

  /** 服务端 websearch 检索；不指定 providerID 时由服务端选择已配置后端 */
  async function webSearch({ query, providerID }) {
    try {
      const out = await client.websearch.query(providerID ? { query, providerID } : { query });
      return out?.data ?? { providerID: "", results: [] };
    } catch (error) {
      fail("websearch 检索", error);
    }
  }

  /** 建会话：2.x 支持创建时直接绑定模型/agent */
  async function createSession({ model, agent, title } = {}) {
    try {
      const input = {};
      if (model) input.model = model;
      if (agent) input.agent = agent;
      if (title) input.title = title;
      return await client.session.create(input);
    } catch (error) {
      fail("创建会话", error);
    }
  }

  async function deleteSession(sessionId) {
    try {
      await client.session.remove({ sessionID: sessionId });
    } catch {
      // 清理会话失败不影响主流程（后端可能已在重启）
    }
  }

  async function abortSession(sessionId) {
    try {
      await client.session.interrupt({ sessionID: sessionId });
    } catch {
      // 会话可能已结束
    }
  }

  /** 续接会话时对齐模型（2.x 模型绑定在会话上） */
  async function switchModel(sessionId, model) {
    try {
      await client.session.switchModel({ sessionID: sessionId, model });
    } catch (error) {
      fail("切换模型", error);
    }
  }

  /** system 指令注入（2.x 无 per-prompt system，用 instructions entry 承载） */
  async function putInstruction(sessionId, key, value) {
    try {
      await client.session.instructions.entry.put({ sessionID: sessionId, key, value });
    } catch (error) {
      fail("写入 system 指令", error);
    }
  }

  /**
   * 会话消息列表（user/assistant/idle 等 SessionMessageInfo）。
   * 2.x 默认按新→旧返回，这里固定 order=asc（旧→新），
   * 保证「最后一条 assistant」就是最新结果（requireAssistant 依赖该顺序）。
   */
  async function getMessages(sessionId) {
    try {
      const out = await client.message.list({ sessionID: sessionId, order: "asc" });
      return out?.data ?? [];
    } catch (error) {
      fail("读取消息", error);
    }
  }

  /**
   * 阻塞式推理（非流式端点用）：prompt → wait → 读最终助手消息。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text 单段提示文本（历史折叠已由上层完成）
   * @param {Array<{ uri: string }>} [options.files] 图片附件（data: URI）
   * @param {string} [options.system] system 指令（经 instructions entry 注入）
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<NormalizedAssistant>}
   */
  async function prompt({ sessionId, text, files, system, signal: externalSignal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROMPT_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      if (system) await putInstruction(sessionId, "gateway-system", system);
      await client.session.prompt(promptInput(sessionId, text, files), { signal: controller.signal });
      await client.session.wait({ sessionID: sessionId }, { signal: controller.signal });
      return await requireAssistant(sessionId);
    } catch (error) {
      if (timedOut) throw upstreamError(`推理超时（>${PROMPT_TIMEOUT_MS / 1000}s）`);
      if (controller.signal.aborted) throw upstreamError("推理已中止");
      if (error?.name === "ApiError") throw error;
      fail("推理请求", error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * 流式推理：先订阅事件桥接 session.text.delta，再 prompt → wait，
   * 结束后以最终助手消息对账补发差量（订阅窗口外丢失的开头文本一次性补齐）。
   * @param {object} options
   * @param {(delta: string) => void} options.onDelta 文本增量回调
   * @returns {Promise<NormalizedAssistant>}
   */
  async function promptStream({ sessionId, text, files, system, onDelta, signal: externalSignal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROMPT_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let emitted = "";
    let closed = false;

    // 后台消费事件流：只关心本会话的文本增量（delta 事件 data 里带 sessionID）
    const consume = (async () => {
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (closed) break;
          if (event?.type !== "session.text.delta") continue;
          if (event.data?.sessionID !== sessionId) continue;
          const delta = event.data?.delta;
          if (typeof delta === "string" && delta.length > 0) {
            emitted += delta;
            onDelta(delta);
          }
        }
      } catch {
        // 流中断：最终结果仍从最终消息取，不影响正确性
      }
    })();

    try {
      if (system) await putInstruction(sessionId, "gateway-system", system);
      await client.session.prompt(promptInput(sessionId, text, files), { signal: controller.signal });
      await client.session.wait({ sessionID: sessionId }, { signal: controller.signal });
      closed = true;
      controller.abort();
      await consume;
      const result = await requireAssistant(sessionId);
      if (result.error) throw upstreamError(`推理失败：${result.error}`);

      // 差量补发：以最终文本为准，补齐订阅窗口外丢失的开头/结尾
      if (!result.text.startsWith(emitted)) {
        onDelta(result.text);
      } else if (result.text.length > emitted.length) {
        onDelta(result.text.slice(emitted.length));
      }
      return result;
    } catch (error) {
      closed = true;
      controller.abort();
      await consume;
      if (timedOut) throw upstreamError(`推理超时（>${PROMPT_TIMEOUT_MS / 1000}s）`);
      if (controller.signal.aborted && externalSignal?.aborted) throw upstreamError("推理已中止");
      if (error?.name === "ApiError") throw error;
      fail("推理请求", error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 2.x prompt 入参：文本 + data: URI 附件 */
  function promptInput(sessionId, text, files) {
    const input = { sessionID: sessionId, text };
    if (Array.isArray(files) && files.length > 0) input.files = files;
    return input;
  }

  /** 取最后一条助手消息并归一化；找不到时结合 session.outcome 给出可诊断错误 */
  async function requireAssistant(sessionId) {
    const messages = await getMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.type === "assistant") return normalizeAssistant(message);
    }
    let outcome = "unknown";
    try {
      outcome = (await client.session.get({ sessionID: sessionId }))?.outcome ?? "unknown";
    } catch {
      // 读取会话状态失败不影响主错误信息
    }
    throw upstreamError(`推理未返回助手消息（session.outcome=${outcome}）`);
  }

  return {
    baseUrl,
    getServerInfo,
    health,
    listModels,
    listWebSearchProviders,
    webSearch,
    createSession,
    deleteSession,
    abortSession,
    switchModel,
    putInstruction,
    getMessages,
    prompt,
    promptStream,
  };
}

/**
 * @typedef {object} NormalizedAssistant
 * @property {string} messageId
 * @property {string} text 拼接后的纯文本（跳过 reasoning/tool）
 * @property {string} reasoning 拼接后的思考文本
 * @property {Array<{ id: string, name: string, state: string, input: unknown, output: string, error: string|null }>} tools
 * @property {string} finish OpenCode finish 枚举（stop/length/tool-calls/content-filter/error/unknown）
 * @property {{ input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null} tokens
 * @property {number} cost
 * @property {string|null} error 消息内嵌错误文本（如 ProviderAuthError）
 */

/** 助手消息（SessionMessageAssistant）→ 归一化结构 */
export function normalizeAssistant(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
  const reasoning = content.filter((item) => item.type === "reasoning").map((item) => item.text ?? "").join("");
  const tools = content.filter((item) => item.type === "tool").map((item) => ({
    id: item.id ?? "",
    name: item.name ?? "",
    state: item.state?.status ?? "unknown",
    input: item.state?.input,
    output: toolOutputText(item.state),
    error: structuredErrorText(item.state?.error),
  }));
  return {
    messageId: message.id ?? "",
    text,
    reasoning,
    tools,
    finish: message.finish ?? "unknown",
    tokens: message.tokens ?? null,
    cost: message.cost ?? 0,
    error: structuredErrorText(message.error),
  };
}

/** SessionStructuredError（{type,message,status?}）→ "type: message"（无则 null） */
function structuredErrorText(error) {
  if (!error) return null;
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  return error.type ? `${error.type}: ${message}` : message;
}

/** 工具 completed/error 状态里的文本内容拼接（content: [{type:"text",text}|{type:"file",...}]） */
function toolOutputText(state) {
  if (!Array.isArray(state?.content)) return "";
  return state.content
    .map((item) => (item?.type === "text" ? (item.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
