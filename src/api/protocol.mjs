// Protocol conversion: OpenCode messages → OpenAI Chat / OpenAI Responses / Anthropic Messages formats.
// Pure functions, easy to unit test (response examples in api.md §4/§5/§6).
import { randomBytes } from "node:crypto";

export const nowSec = () => Math.floor(Date.now() / 1000);
export const newId = (prefix) => `${prefix}${randomBytes(12).toString("hex")}`;

/** OpenCode tokens accounting → OpenAI usage (all zeros when missing, api.md §4) */
export function toOpenAiUsage(tokens) {
  if (!tokens) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = (tokens.input ?? 0) + (tokens.cache?.read ?? 0);
  const completion = tokens.output ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** OpenCode tokens → Responses/Anthropic usage */
export function toSplitUsage(tokens) {
  if (!tokens) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: (tokens.input ?? 0) + (tokens.cache?.read ?? 0),
    output_tokens: tokens.output ?? 0,
  };
}

/** OpenAI non-streaming chat.completion */
export function chatCompletion({ id, model, text, tokens, finishReason = "stop" }) {
  return {
    id,
    object: "chat.completion",
    created: nowSec(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: toOpenAiUsage(tokens),
  };
}

/** OpenAI streaming chunk; role is sent only on the first chunk (api.md §4); created is pinned by the caller so one response stays consistent */
export function chatChunk({ id, model, delta, finishReason = null, tokens, created = nowSec() }) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (tokens) chunk.usage = toOpenAiUsage(tokens);
  return chunk;
}

/** Responses non-streaming object (api.md §5) */
export function responsesObject({ id, model, text, tokens }) {
  return {
    id,
    object: "response",
    created_at: nowSec(),
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: newId("msg_"),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: toSplitUsage(tokens),
  };
}

/** Anthropic non-streaming message (api.md §6) */
export function anthropicMessage({ id, model, text, tokens, stopReason = "end_turn" }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: toSplitUsage(tokens),
  };
}

// 2.x finish enum (stop/length/tool-calls/content-filter/error/unknown) → per-protocol terminal field
const OPENAI_FINISH = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool_calls",
  "content-filter": "content_filter",
  error: "stop",
  unknown: "stop",
};
const ANTHROPIC_STOP = {
  stop: "end_turn",
  length: "max_tokens",
  "tool-calls": "tool_use",
  "content-filter": "end_turn",
  error: "end_turn",
  unknown: "end_turn",
};

/** OpenCode finish → OpenAI finish_reason */
export function toOpenAiFinish(finish) {
  return OPENAI_FINISH[finish] ?? "stop";
}

/** OpenCode finish → Anthropic stop_reason */
export function toAnthropicStop(finish) {
  return ANTHROPIC_STOP[finish] ?? "end_turn";
}

/**
 * Normalize OpenAI/Anthropic conversation messages into "a single prompt text + attachments + system".
 * The 2.x prompt input is a single text string (no parts array), so multi-turn history is folded into
 * context segments with role prefixes and joined with the last message (design.md §4.2); image attachments
 * become data: URIs passed through as files.
 * @param {Array<{ role: string, content: unknown }>} messages
 * @returns {{ system: string, text: string, files: Array<{ uri: string }> }}
 */
export function messagesToPrompt(messages) {
  const texts = [];
  const files = [];
  let system = "";
  const history = [];
  for (const message of messages ?? []) {
    const { text, images } = extractContent(message.content);
    for (const uri of images) files.push({ uri });
    if (message.role === "system") {
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    history.push({ role: message.role === "assistant" ? "assistant" : "user", text });
  }
  if (history.length === 0) return { system, text: "", files };
  const last = history.pop();
  for (const item of history) {
    texts.push(`[${item.role}]\n${item.text}`);
  }
  if (history.length > 0) texts.push("---\n请延续以上对话。");
  texts.push(last.text);
  return { system, text: texts.join("\n\n"), files };
}

/**
 * content (string / block array) → plain text + list of image URIs.
 * Supports both OpenAI ({type:"image_url",image_url:{url}}) and Anthropic ({type:"image",source:{type:"base64",media_type,data}}) image blocks.
 */
export function extractContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  const texts = [];
  const images = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        texts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") continue;
      if (block.type === "image_url" && typeof block.image_url?.url === "string") {
        images.push(block.image_url.url);
      } else if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
        images.push(`data:${block.source.media_type ?? "image/png"};base64,${block.source.data}`);
      } else if (typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  } else if (content != null) {
    return { text: String(content), images: [] };
  }
  return { text: texts.filter(Boolean).join("\n"), images };
}

/** Responses input (string or array of input items) → messages */
export function inputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.role === "string") {
      // Responses API message items are {type:"message",role,content}; matching on role also covers the loose form without type
      messages.push({ role: item.role, content: flattenContent(item.content ?? item.text) });
    } else if (item.type === "input_text" || item.type === "text") {
      messages.push({ role: "user", content: String(item.text ?? "") });
    }
  }
  return messages;
}

/** Anthropic content (string or [{type:"text",text}] array) → plain text */
export function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}
