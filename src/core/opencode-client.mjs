// SDK adapter layer: wraps @opencode/client (2.x Promise client, version-locked with @opencode/cli)
// and exposes a normalized interface upward with unified errors (design.md §5.2).
// Note: the SDK and opencode serve versions must match; upgrade both together (AGENTS.md §6).
//
// Key differences between 2.x and 1.x (migration basis, verified in practice):
// - Client factory is OpenCode.make({ baseUrl, headers, fetch? }); failures throw Error (name=_tag or ClientError);
// - Health probe uses GET /api/info (returns { version, pid, urls, paths });
// - Models are first-class: model.list() returns ModelInfo[] directly (no longer nested in providers);
// - session.prompt is async dispatch (returns an inbox receipt); call session.wait() to wait for completion;
// - No per-prompt system: inject via session.instructions.entry.put({ key, value });
// - Streaming deltas are a dedicated event session.text.delta (data.delta); session.text.ended carries the authoritative full text for reconciliation;
// - Assistant result messages are content:[{type:text|reasoning|tool}] + finish (OpenAI-style enum) + tokens + cost.
import { OpenCode } from "@opencode/client";
import { promptUpstreamError, upstreamError } from "./errors.mjs";

const PROMPT_TIMEOUT_MS = 300000; // max 5 minutes per inference (agent tasks can be slow)
const HEALTH_TIMEOUT_MS = 5000;
const MODEL_LIST_TIMEOUT_MS = 15000;

/**
 * @param {object} options
 * @param {string} options.baseUrl opencode serve address
 * @param {string} options.password OPENCODE_SERVER_PASSWORD (HTTP Basic, username fixed to opencode)
 * @param {typeof globalThis.fetch} [options.fetch] for injection (tests pass a fake fetch)
 */
export function createBackendClient({ baseUrl, password, fetch: fetchImpl }) {
  const headers = {};
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }
  const client = OpenCode.make(fetchImpl ? { baseUrl, headers, fetch: fetchImpl } : { baseUrl, headers });

  /** 2.x failures are uniformly Error: business errors use name=_tag (e.g. UnauthorizedError), transport errors are ClientError */
  function fail(action, error) {
    const detail = error?.message ?? String(error);
    throw upstreamError(`${action} failed: ${detail}`);
  }

  /** Health probe: returns ServerInfo ({version,pid,urls,paths}) on success, null on failure */
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

  /** Model list (built-in free models plus configured provider models; disabled/deprecated ones are dropped in the resolver) */
  async function listModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
      const out = await client.model.list(undefined, { signal: controller.signal });
      return out?.data ?? [];
    } catch (error) {
      if (controller.signal.aborted) {
        throw upstreamError(`model list timed out (>${MODEL_LIST_TIMEOUT_MS / 1000}s)`);
      }
      fail("model list", error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Server-side websearch backend catalog (exa/tavily/..., api.md §9) */
  async function listWebSearchProviders() {
    try {
      const out = await client.websearch.providers();
      return out?.data ?? [];
    } catch (error) {
      fail("websearch provider catalog", error);
    }
  }

  /** Server-side websearch query; when providerID is omitted the server picks a configured backend */
  async function webSearch({ query, providerID }) {
    try {
      const out = await client.websearch.query(providerID ? { query, providerID } : { query });
      return out?.data ?? { providerID: "", results: [] };
    } catch (error) {
      fail("websearch query", error);
    }
  }

  /** Create a session: 2.x can bind the model/agent at creation time */
  async function createSession({ model, agent, title } = {}) {
    try {
      const input = {};
      if (model) input.model = model;
      if (agent) input.agent = agent;
      if (title) input.title = title;
      return await client.session.create(input);
    } catch (error) {
      fail("session create", error);
    }
  }

  async function deleteSession(sessionId) {
    try {
      await client.session.remove({ sessionID: sessionId });
    } catch {
      // session cleanup failure does not affect the main flow (backend may be restarting)
    }
  }

  async function abortSession(sessionId) {
    try {
      await client.session.interrupt({ sessionID: sessionId });
    } catch {
      // session may already have ended
    }
  }

  /** Align the model when continuing a session (2.x binds the model to the session) */
  async function switchModel(sessionId, model) {
    try {
      await client.session.switchModel({ sessionID: sessionId, model });
    } catch (error) {
      fail("model switch", error);
    }
  }

  /** system instruction injection (2.x has no per-prompt system; carried by an instructions entry) */
  async function putInstruction(sessionId, key, value) {
    try {
      await client.session.instructions.entry.put({ sessionID: sessionId, key, value });
    } catch (error) {
      fail("system instructions write", error);
    }
  }

  /**
   * Session message list (user/assistant/idle etc. as SessionMessageInfo).
   * 2.x returns newest→oldest by default; we pin order=asc (oldest→newest)
   * so that "the last assistant message" is the latest result (requireAssistant relies on that order).
   */
  async function getMessages(sessionId) {
    try {
      const out = await client.message.list({ sessionID: sessionId, order: "asc" });
      return out?.data ?? [];
    } catch (error) {
      fail("message read", error);
    }
  }

  /**
   * Blocking inference (for non-streaming endpoints): prompt → wait → read the final assistant message.
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text single-segment prompt text (history folding is already done upstream)
   * @param {Array<{ uri: string }>} [options.files] image attachments (data: URI)
   * @param {string} [options.system] system instruction (injected via an instructions entry)
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
      if (timedOut) throw upstreamError(`inference timed out (>${PROMPT_TIMEOUT_MS / 1000}s)`);
      if (controller.signal.aborted) throw upstreamError("inference aborted");
      if (error?.name === "ApiError") throw error;
      fail("inference request", error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Streaming inference: subscribe first to bridge session.text.delta, then prompt → wait;
   * after completion, reconcile against the final assistant message and emit any missing delta
   * (leading text lost outside the subscription window is back-filled in one go).
   * @param {object} options
   * @param {(delta: string) => void} options.onDelta text delta callback
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

    // Background event-stream consumer: only cares about text deltas for this session (delta event data carries sessionID)
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
        // stream interrupted: the final result still comes from the final message, so correctness is unaffected
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
      if (result.error) throw promptUpstreamError(result.error);

      // Delta back-fill: trust the final text and emit whatever was lost outside the subscription window (head/tail)
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
      if (timedOut) throw upstreamError(`inference timed out (>${PROMPT_TIMEOUT_MS / 1000}s)`);
      if (controller.signal.aborted && externalSignal?.aborted) throw upstreamError("inference aborted");
      if (error?.name === "ApiError") throw error;
      fail("inference request", error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 2.x prompt input: text + data: URI attachments */
  function promptInput(sessionId, text, files) {
    const input = { sessionID: sessionId, text };
    if (Array.isArray(files) && files.length > 0) input.files = files;
    return input;
  }

  /** Take the last assistant message and normalize it; when absent, produce a diagnosable error from session.outcome */
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
      // failing to read session state does not affect the primary error message
    }
    throw upstreamError(`inference returned no assistant message (session.outcome=${outcome})`);
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
 * @property {string} text concatenated plain text (reasoning/tool skipped)
 * @property {string} reasoning concatenated thinking text
 * @property {Array<{ id: string, name: string, state: string, input: unknown, output: string, error: string|null }>} tools
 * @property {string} finish OpenCode finish enum (stop/length/tool-calls/content-filter/error/unknown)
 * @property {{ input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null} tokens
 * @property {number} cost
 * @property {string|null} error error text embedded in the message (e.g. ProviderAuthError)
 */

/** Assistant message (SessionMessageAssistant) → normalized structure */
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

/** SessionStructuredError ({type,message,status?}) → "type: message" (null when absent) */
function structuredErrorText(error) {
  if (!error) return null;
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  return error.type ? `${error.type}: ${message}` : message;
}

/** Concatenate text content from a tool's completed/error state (content: [{type:"text",text}|{type:"file",...}]) */
function toolOutputText(state) {
  if (!Array.isArray(state?.content)) return "";
  return state.content
    .map((item) => (item?.type === "text" ? (item.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
