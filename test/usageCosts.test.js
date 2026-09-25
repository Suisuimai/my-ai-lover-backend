const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateUsageCosts, deepSeekPricingForEvent, normalizeOpenRouterPricing, shanghaiPeriodStarts } = require("../core/usageCosts");

test("calculates provider-reported cost and cache savings from model pricing", () => {
  const result = calculateUsageCosts({
    provider_cost: 0.03, input_tokens: 28000, output_tokens: 200,
    cache_read_tokens: 26800, cache_write_tokens: 0, cache_write_1h_tokens: 0,
  }, { prompt: 0.000005, completion: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625, cacheWrite1h: 0.00001 });
  assert.equal(result.actualCost, 0.03);
  assert.equal(result.cacheSavings, 0.1206);
  assert.equal(result.withoutCacheCost, 0.1506);
  assert.equal(result.costSource, "provider_reported");
});

test("calculates one-hour cache creation as a temporary extra cost", () => {
  const result = calculateUsageCosts({
    provider_cost: null, input_tokens: 10000, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 10000,
  }, { prompt: 0.000005, completion: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625, cacheWrite1h: 0.00001 });
  assert.equal(result.actualCost, 0.1);
  assert.equal(result.cacheSavings, -0.05);
  assert.equal(result.withoutCacheCost, 0.05);
});

test("normalizes OpenRouter prices and finds Shanghai day and month starts", () => {
  const prices = normalizeOpenRouterPricing({ data: [{ id: "model/a", pricing: { prompt: "0.1", completion: "0.2", input_cache_read: "0.01" } }] });
  assert.equal(prices.get("model/a").cacheRead, 0.01);
  const starts = shanghaiPeriodStarts(new Date("2026-09-18T16:30:00Z"));
  assert.equal(starts.today.toISOString(), "2026-09-18T16:00:00.000Z");
  assert.equal(starts.month.toISOString(), "2026-08-31T16:00:00.000Z");
});

test("estimates direct DeepSeek flash cost with Shanghai peak and cache pricing", () => {
  const event = {
    provider: "deepseek", resolved_model: "deepseek-flash", started_at: "2026-09-24T02:00:00.000Z",
    input_tokens: 10000, output_tokens: 1000, cache_read_tokens: 8000,
    cache_write_tokens: 0, cache_write_1h_tokens: 0, provider_cost: null,
  };
  const result = calculateUsageCosts(event, deepSeekPricingForEvent(event));
  assert.ok(Math.abs(result.actualCost - 0.001848) < 1e-12);
  assert.ok(Math.abs(result.withoutCacheCost - 0.0042) < 1e-12);
  assert.ok(Math.abs(result.cacheSavings - 0.002352) < 1e-12);
  assert.equal(result.costSource, "catalog_estimate");
});
