// SSE write helpers: one streaming implementation for all three protocols (OpenAI chat / OpenAI responses / Anthropic).
// Once SSE writing starts the status code can no longer change (AGENTS.md §4.3); errors are expressed as in-stream events.

/** Switch reply into SSE mode and return the write functions */
export function startSse(reply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return {
    /** @param {string} event event name (used by Anthropic; left empty for the OpenAI family) @param {unknown} data */
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
