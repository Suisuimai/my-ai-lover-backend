function price(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeOpenRouterPricing(payload) {
  return new Map((Array.isArray(payload?.data) ? payload.data : []).flatMap((model) => {
    if (!model?.id || !model?.pricing) return [];
    return [[String(model.id), {
      prompt: price(model.pricing.prompt),
      completion: price(model.pricing.completion),
      cacheRead: price(model.pricing.input_cache_read),
      cacheWrite: price(model.pricing.input_cache_write),
      cacheWrite1h: price(model.pricing.input_cache_write_1h),
    }]];
  }));
}

function calculateUsageCosts(event, modelPricing) {
  const providerCost = price(event.provider_cost);
  if (!modelPricing || modelPricing.prompt === null || modelPricing.completion === null) {
    return { actualCost: providerCost, withoutCacheCost: providerCost, cacheSavings: null, costSource: providerCost === null ? "unavailable" : "provider_reported" };
  }

  const input = Number(event.input_tokens) || 0;
  const output = Number(event.output_tokens) || 0;
  const cacheRead = Number(event.cache_read_tokens) || 0;
  const cacheWrite = Number(event.cache_write_tokens) || 0;
  const cacheWrite1h = Number(event.cache_write_1h_tokens) || 0;
  const ordinaryInput = Math.max(0, input - cacheRead - cacheWrite - cacheWrite1h);
  const cacheReadPrice = modelPricing.cacheRead ?? modelPricing.prompt;
  const cacheWritePrice = modelPricing.cacheWrite ?? modelPricing.prompt;
  const cacheWrite1hPrice = modelPricing.cacheWrite1h ?? cacheWritePrice;
  const estimatedActual = ordinaryInput * modelPricing.prompt
    + cacheRead * cacheReadPrice
    + cacheWrite * cacheWritePrice
    + cacheWrite1h * cacheWrite1hPrice
    + output * modelPricing.completion;
  const actualCost = providerCost ?? estimatedActual;
  const cacheSavings = cacheRead * (modelPricing.prompt - cacheReadPrice)
    - cacheWrite * (cacheWritePrice - modelPricing.prompt)
    - cacheWrite1h * (cacheWrite1hPrice - modelPricing.prompt);

  return {
    actualCost,
    withoutCacheCost: actualCost + cacheSavings,
    cacheSavings,
    costSource: providerCost === null ? "catalog_estimate" : "provider_reported",
  };
}

function shanghaiPeriodStarts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    today: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`),
    month: new Date(`${parts.year}-${parts.month}-01T00:00:00+08:00`),
  };
}

module.exports = { calculateUsageCosts, normalizeOpenRouterPricing, shanghaiPeriodStarts };
