const express = require("express");
const { supabase } = require("../services/db");
const { openRouterPricingCache } = require("../services/model");
const { calculateUsageCosts, deepSeekPricingForEvent, normalizeOpenRouterPricing, shanghaiPeriodStarts } = require("../core/usageCosts");

const router = express.Router();

router.get("/api-usage-events", async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 30));
    const periodStarts = shanghaiPeriodStarts();
    const { data, error } = await supabase.from("api_usage_events")
      .select("id,purpose,provider,requested_model,resolved_model,status,completion_status,finish_reason,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,cache_write_1h_tokens,provider_cost,cost_currency,cost_source,duration_ms,preparation_ms,first_token_ms,started_at")
      .eq("user_id", req.user.id)
      .gte("started_at", periodStarts.month.toISOString())
      .order("started_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    const events = data || [];
    if (events.some((event) => event.provider === "openrouter")
      && Date.now() - openRouterPricingCache.loadedAt > 24 * 60 * 60 * 1000) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const refreshed = normalizeOpenRouterPricing(await response.json());
        openRouterPricingCache.loadedAt = Date.now();
        openRouterPricingCache.prices = refreshed;
      } catch (pricingError) {
        console.error("OpenRouter pricing refresh failed:", pricingError.message);
      }
    }
    const pricedEvents = events.map((event) => {
      const modelId = event.resolved_model || event.requested_model;
      const pricing = event.provider === "openrouter"
        ? openRouterPricingCache.prices.get(modelId)
        : (event.provider === "deepseek" ? deepSeekPricingForEvent(event) : null);
      const costs = calculateUsageCosts(event, pricing);
      return { event, costs };
    });
    const summarize = (items) => items.reduce((summary, item) => ({
      actualCost: summary.actualCost + (item.costs.actualCost || 0),
      cacheSavings: summary.cacheSavings + (item.costs.cacheSavings || 0),
      pricedCalls: summary.pricedCalls + (item.costs.actualCost === null ? 0 : 1),
      totalCalls: summary.totalCalls + 1,
    }), { actualCost: 0, cacheSavings: 0, pricedCalls: 0, totalCalls: 0 });
    const todayEvents = pricedEvents.filter(({ event }) => new Date(event.started_at) >= periodStarts.today);
    res.json({
      success: true,
      exchangeRate: 6.7,
      summary: {
        today: summarize(todayEvents),
        month: summarize(pricedEvents),
      },
      events: pricedEvents.slice(0, limit).map(({ event, costs }) => ({
        id: event.id,
        purpose: event.purpose,
        provider: event.provider,
        requestedModel: event.requested_model,
        resolvedModel: event.resolved_model,
        status: event.status,
        completionStatus: event.completion_status,
        finishReason: event.finish_reason,
        inputTokens: event.input_tokens || 0,
        outputTokens: event.output_tokens || 0,
        totalTokens: event.total_tokens || 0,
        cachedTokens: event.cache_read_tokens || 0,
        cacheWriteTokens: (event.cache_write_tokens || 0) + (event.cache_write_1h_tokens || 0),
        actualCost: costs.actualCost,
        withoutCacheCost: costs.withoutCacheCost,
        cacheSavings: costs.cacheSavings,
        costCurrency: event.cost_currency,
        costSource: costs.costSource,
        durationMs: event.duration_ms,
        preparationMs: event.preparation_ms,
        firstTokenMs: event.first_token_ms,
        startedAt: event.started_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
