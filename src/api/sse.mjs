// SSE 写入辅助：统一三家协议（OpenAI chat / OpenAI responses / Anthropic）的流式写法。
// 一旦开始写 SSE 就不能再改状态码（AGENTS.md §4.3），错误用流内事件表达。

/** 把 reply 切换到 SSE 模式并返回写入函数 */
export function startSse(reply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return {
    /** @param {string} event 事件名（Anthropic 用；OpenAI 系留空） @param {unknown} data */
    send(event, data) {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      let frame = "";
      if (event) frame += `event: ${event}\n`;
      frame += `data: ${payload}\n\n`;
      reply.raw.write(frame);
    },
    end() {
      reply.raw.end();
    },
  };
}
