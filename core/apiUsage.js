function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function finiteDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeModelUsage(providerName, data = {}) {
  const usage = data?.usage || {};
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || usage.output_tokens_details || {};
  const inputTokens = nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.completion_tokens ?? usage.output_tokens);
  const reportedTotal = nonNegativeInteger(usage.total_tokens);

  const normalized = {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
    cacheReadTokens: nonNegativeInteger(
      promptDetails.cached_tokens ?? usage.cache_read_input_tokens,
    ),
    cacheWriteTokens: nonNegativeInteger(
      promptDetails.cache_write_tokens ?? usage.cache_creation_input_tokens,
    ),
    cacheWrite1hTokens: nonNegativeInteger(
      promptDetails.cache_write_tokens_1h ?? usage.cache_creation_input_tokens_1h,
    ),
    cacheHitTokens: nonNegativeInteger(usage.prompt_cache_hit_tokens),
    cacheMissTokens: nonNegativeInteger(usage.prompt_cache_miss_tokens),
    reasoningTokens: nonNegativeInteger(
      completionDetails.reasoning_tokens ?? usage.reasoning_tokens,
    ),
    providerCost: finiteDecimal(usage.cost),
    costCurrency: usage.cost === null || usage.cost === undefined ? null : "USD",
    costSource: usage.cost === null || usage.cost === undefined ? "unavailable" : "provider_reported",
    providerUsage: usage && typeof usage === "object" ? usage : {},
  };

  if (providerName === "deepseek") {
    normalized.cacheHitTokens = nonNegativeInteger(usage.prompt_cache_hit_tokens);
    normalized.cacheMissTokens = nonNegativeInteger(usage.prompt_cache_miss_tokens);
  }

  return normalized;
}

function apiErrorCode(data, httpStatus) {
  const candidate = data?.error?.code ?? data?.code;
  if (["string", "number"].includes(typeof candidate)) return String(candidate).slice(0, 120);
  return httpStatus ? `http_${httpStatus}` : null;
}

module.exports = { apiErrorCode, normalizeModelUsage };
