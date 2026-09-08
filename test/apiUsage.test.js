const test = require("node:test");
const assert = require("node:assert/strict");
const { apiErrorCode, normalizeModelUsage } = require("../core/apiUsage");

test("normalizes OpenRouter usage including cache and provider cost", () => {
  const result = normalizeModelUsage("openrouter", {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0123,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  });
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.cacheReadTokens, 60);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.reasoningTokens, 4);
  assert.equal(result.providerCost, 0.0123);
  assert.equal(result.costSource, "provider_reported");
});

test("normalizes DeepSeek cache hit and miss tokens", () => {
  const result = normalizeModelUsage("deepseek", {
    usage: {
      prompt_tokens: 90,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 20,
    },
  });
  assert.equal(result.totalTokens, 100);
  assert.equal(result.cacheHitTokens, 70);
  assert.equal(result.cacheMissTokens, 20);
  assert.equal(result.providerCost, null);
  assert.equal(result.costSource, "unavailable");
});

test("normalizes Anthropic cache usage", () => {
  const result = normalizeModelUsage("anthropic", {
    usage: {
      input_tokens: 30,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 8,
    },
  });
  assert.equal(result.totalTokens, 35);
  assert.equal(result.cacheReadTokens, 20);
  assert.equal(result.cacheWriteTokens, 8);
});

test("extracts a safe API error code without retaining the message", () => {
  assert.equal(apiErrorCode({ error: { code: "insufficient_credits", message: "secret text" } }, 402), "insufficient_credits");
  assert.equal(apiErrorCode({}, 503), "http_503");
});
