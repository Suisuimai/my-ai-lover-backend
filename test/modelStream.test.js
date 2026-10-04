const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCompletion, readModelEventStream } = require("../core/modelStream");

test("flushes a final SSE block without a trailing blank line", async () => {
  const body = 'data: {"choices":[{"delta":{"content":"半句后面"},"finish_reason":"stop"}]}';
  const result = await readModelEventStream(new Response(body), { providerType: "openai-compatible" });
  assert.equal(result.text, "半句后面");
  assert.deepEqual(result.completion, { complete: true, status: "complete", finishReason: "stop" });
});

test("distinguishes length from abnormal EOF", async () => {
  const lengthBody = 'data: {"choices":[{"delta":{"content":"未完"},"finish_reason":"length"}]}\n\n';
  const limited = await readModelEventStream(new Response(lengthBody), { providerType: "openai-compatible" });
  assert.equal(limited.completion.status, "length");
  const eofBody = 'data: {"choices":[{"delta":{"content":"突然断掉"},"finish_reason":null}]}\n\n';
  const eof = await readModelEventStream(new Response(eofBody), { providerType: "openai-compatible" });
  assert.equal(eof.completion.status, "abnormal_eof");
});

test("normalizes Anthropic terminal reasons", () => {
  assert.equal(normalizeCompletion("anthropic", "end_turn", true).complete, true);
  assert.equal(normalizeCompletion("anthropic", "max_tokens", true).status, "length");
});
