const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { calculateUsageCosts, deepSeekPricingForEvent, normalizeOpenRouterPricing, shanghaiPeriodStarts } = require("../core/usageCosts");
const { FEATURE_PURPOSES } = require("../core/apiConnections");

let openRouterPricingCache = { loadedAt: 0, prices: new Map() };

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
        openRouterPricingCache = {
          loadedAt: Date.now(),
          prices: normalizeOpenRouterPricing(await response.json()),
        };
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

router.get("/api-feature-routes", async (req, res) => {
  try {
    const [{ data: routes, error: routeError }, { data: connections, error: connectionError }] = await Promise.all([
      supabase.from("api_feature_routes").select("purpose,connection_id,model_id,follows_purpose,enabled,updated_at")
        .eq("user_id", req.user.id).order("purpose"),
      supabase.from("api_connections").select("id,label").eq("user_id", req.user.id),
    ]);
    if (routeError) throw routeError;
    if (connectionError) throw connectionError;
    const labels = new Map((connections || []).map((connection) => [connection.id, connection.label]));
    res.json({ success: true, routes: (routes || []).map((route) => ({
      purpose: route.purpose,
      connectionId: route.connection_id,
      connectionLabel: labels.get(route.connection_id) || "Unknown connection",
      modelId: route.model_id,
      followsPurpose: route.follows_purpose,
      enabled: route.enabled,
      updatedAt: route.updated_at,
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put("/api-feature-routes/:purpose", async (req, res) => {
  const purpose = req.params.purpose;
  const followsPurpose = typeof req.body.followsPurpose === "string" ? req.body.followsPurpose : null;
  if (!FEATURE_PURPOSES.has(purpose) || (followsPurpose && (!FEATURE_PURPOSES.has(followsPurpose) || followsPurpose === purpose))) {
    return res.status(400).json({ success: false, error: "Unsupported feature assignment" });
  }
  try {
    let connectionId = typeof req.body.connectionId === "string" ? req.body.connectionId : "";
    let modelId = typeof req.body.modelId === "string" ? req.body.modelId.trim().slice(0, 300) : "";

    if (followsPurpose) {
      const { data: source, error } = await supabase.from("api_feature_routes")
        .select("connection_id,model_id,follows_purpose,enabled")
        .eq("user_id", req.user.id).eq("purpose", followsPurpose).maybeSingle();
      if (error) throw error;
      if (!source?.enabled || source.follows_purpose) {
        return res.status(400).json({ success: false, error: "A feature can only follow a direct, enabled assignment" });
      }
      connectionId = source.connection_id;
      modelId = source.model_id;
    }

    if (!connectionId || !modelId) return res.status(400).json({ success: false, error: "Connection and model are required" });
    const { data: connection, error: connectionError } = await supabase.from("api_connections").select("id,api_format")
      .eq("id", connectionId).eq("user_id", req.user.id).eq("enabled", true).maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) return res.status(400).json({ success: false, error: "Choose an enabled connection" });
    if (purpose === "embedding" && connection.api_format !== "openai_compatible") {
      return res.status(400).json({ success: false, error: "Semantic recall requires an OpenAI-compatible connection" });
    }

    const { data, error } = await supabase.from("api_feature_routes").upsert({
      user_id: req.user.id,
      purpose,
      connection_id: connectionId,
      model_id: modelId,
      follows_purpose: followsPurpose,
      enabled: req.body.enabled !== false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,purpose" }).select().single();
    if (error) throw error;
    res.json({ success: true, route: {
      purpose: data.purpose, connectionId: data.connection_id, modelId: data.model_id,
      followsPurpose: data.follows_purpose, enabled: data.enabled, updatedAt: data.updated_at,
    } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;