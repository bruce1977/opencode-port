// 协议转换纯函数单测（api.md §4/§5/§6 的响应形状）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicMessage,
  chatChunk,
  chatCompletion,
  extractContent,
  flattenContent,
  inputToMessages,
  messagesToPrompt,
  newId,
  responsesObject,
  toAnthropicStop,
  toOpenAiFinish,
  toOpenAiUsage,
  toSplitUsage,
} from "../src/api/protocol.mjs";

test("toOpenAiUsage：cache.read 计入 prompt_tokens；缺失 tokens 全 0", () => {
  assert.deepEqual(
    toOpenAiUsage({ input: 10, output: 5, cache: { read: 3, write: 0 } }),
    { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
  );
  assert.deepEqual(toOpenAiUsage(null), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("toSplitUsage：Responses/Anthropic 双段统计", () => {
  assert.deepEqual(toSplitUsage({ input: 7, output: 2, cache: { read: 1 } }), { input_tokens: 8, output_tokens: 2 });
  assert.deepEqual(toSplitUsage(undefined), { input_tokens: 0, output_tokens: 0 });
});

test("chatCompletion：结构与 finish_reason", () => {
  const out = chatCompletion({ id: "chatcmpl-x", model: "opencode/glm-4.6-free", text: "你好", tokens: { input: 1, output: 2 } });
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "你好");
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.equal(out.usage.total_tokens, 3);
});

test("chatChunk：默认无 usage，传 tokens 才带", () => {
  const plain = chatChunk({ id: "c", model: "m", delta: { content: "a" } });
  assert.equal(plain.usage, undefined);
  assert.equal(plain.object, "chat.completion.chunk");
  const withUsage = chatChunk({ id: "c", model: "m", delta: {}, tokens: { input: 1, output: 1 } });
  assert.deepEqual(withUsage.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
});

test("responsesObject：output 单条 output_text 消息", () => {
  const out = responsesObject({ id: "resp_1", model: "m", text: "答案", tokens: { input: 4, output: 6 } });
  assert.equal(out.object, "response");
  assert.equal(out.status, "completed");
  assert.equal(out.output[0].content[0].text, "答案");
  assert.deepEqual(out.usage, { input_tokens: 4, output_tokens: 6 });
});

test("anthropicMessage：content 块与 stop_reason", () => {
  const out = anthropicMessage({ id: "msg_1", model: "m", text: " hi ", tokens: { input: 2, output: 3 }, stopReason: "max_tokens" });
  assert.equal(out.type, "message");
  assert.deepEqual(out.content, [{ type: "text", text: " hi " }]);
  assert.equal(out.stop_reason, "max_tokens");
  assert.deepEqual(out.usage, { input_tokens: 2, output_tokens: 3 });
});

test("finish 枚举映射：2.x → OpenAI / Anthropic", () => {
  assert.equal(toOpenAiFinish("stop"), "stop");
  assert.equal(toOpenAiFinish("length"), "length");
  assert.equal(toOpenAiFinish("tool-calls"), "tool_calls");
  assert.equal(toOpenAiFinish("content-filter"), "content_filter");
  assert.equal(toOpenAiFinish("unknown"), "stop");
  assert.equal(toOpenAiFinish("whatever-else"), "stop");
  assert.equal(toAnthropicStop("stop"), "end_turn");
  assert.equal(toAnthropicStop("length"), "max_tokens");
  assert.equal(toAnthropicStop("tool-calls"), "tool_use");
  assert.equal(toAnthropicStop("nope"), "end_turn");
});

test("messagesToPrompt：历史折叠 + system 提取 + 末条独立", () => {
  const { system, text, files } = messagesToPrompt([
    { role: "system", content: "你是助手" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
  assert.equal(system, "你是助手");
  assert.match(text, /\[user\]\n第一问/);
  assert.match(text, /\[assistant\]\n第一答/);
  assert.ok(text.endsWith("第二问"));
  assert.match(text, /请延续以上对话。/);
  assert.deepEqual(files, []);
});

test("messagesToPrompt：无历史时末条即全文，不加延续提示", () => {
  const { text } = messagesToPrompt([{ role: "user", content: "只有一句" }]);
  assert.equal(text, "只有一句");
});

test("messagesToPrompt：OpenAI 图片块转 data: URI 附件", () => {
  const { text, files } = messagesToPrompt([
    { role: "user", content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ] },
  ]);
  assert.equal(text, "看图");
  assert.deepEqual(files, [{ uri: "data:image/png;base64,AAAA" }]);
});

test("extractContent：Anthropic base64 图片块 → data: URI", () => {
  const { text, images } = extractContent([
    { type: "text", text: "描述它" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
  ]);
  assert.equal(text, "描述它");
  assert.deepEqual(images, ["data:image/jpeg;base64,BBBB"]);
});

test("extractContent：字符串 / 空 / 非数组容错", () => {
  assert.deepEqual(extractContent("直接文本"), { text: "直接文本", images: [] });
  assert.deepEqual(extractContent(null), { text: "", images: [] });
  assert.deepEqual(extractContent(undefined), { text: "", images: [] });
});

test("inputToMessages：字符串 / message 项 / input_text 项", () => {
  assert.deepEqual(inputToMessages("hi"), [{ role: "user", content: "hi" }]);
  const mixed = inputToMessages([
    { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
    { type: "input_text", text: "b" },
    null,
    42,
  ]);
  assert.deepEqual(mixed, [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  assert.deepEqual(inputToMessages(123), []);
});

test("flattenContent：字符串 / 块数组 / null", () => {
  assert.equal(flattenContent("x"), "x");
  assert.equal(flattenContent([{ type: "text", text: "p" }, "q"]), "p\nq");
  assert.equal(flattenContent(null), "");
});

test("newId：前缀 + 定长 hex 随机串", () => {
  const id = newId("resp_");
  assert.match(id, /^resp_[0-9a-f]{24}$/);
  assert.notEqual(id, newId("resp_"));
});
