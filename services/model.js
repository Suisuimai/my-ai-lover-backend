const dns = require("node:dns").promises;
const { supabase } = require("./db");
const { decryptSecret } = require("./encryption");
const { prepareMessagesForProvider } = require("../core/promptCaching");
const { apiErrorCode, normalizeModelUsage } = require("../core/apiUsage");
const { normalizeCompletion, readModelEventStream } = require("../core/modelStream");
const {
  FEATURE_PURPOSES,
  connectionKind,
  embeddingEndpoint,
  isPrivateIp,
  modelEndpoint,
  normalizeBaseUrl,
} = require("../core/apiConnections");

const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const modelCatalogCache = new Map();
let openRouterPricingCache = { loadedAt: 0, prices: new Map() };

const MODEL_PROVIDERS = [
  {
    name: "deepseek",
    matches: (model) => model.startsWith("deepseek-"),
    type: "openai-compatible",
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: () => process.env.DEEPSEEK_API_KEY,
  },
  {
    name: "openai",
    matches: (model) => /^(gpt-|o[1-9]|chatgpt-)/.test(model),
    type: "openai-compatible",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: () => process.env.OPENAI_API_KEY,
  },
  {
    name: "anthropic",
    matches: (model) => model.startsWith("claude-"),
    type: "anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiKey: () => process.env.ANTHROPIC_API_KEY,
  },
];

function getModelProvider(model) {
  const provider = MODEL_PROVIDERS.find((item) => item.matches(model));
  if (!provider) throw new Error(`Unsupported model: ${model}`);
  return { ...provider, apiKey: provider.apiKey() };
}

function isMissingApiFoundation(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code);
}

async function getModelTarget({ userId, purpose, legacyModel }) {
  if (userId && FEATURE_PURPOSES.has(purpose)) {
    const { data: route, error: routeError } = await supabase.from("api_feature_routes")
      .select("connection_id,model_id,enabled")
      .eq("user_id", userId).eq("purpose", purpose).maybeSingle();
    if (routeError && !isMissingApiFoundation(routeError)) throw routeError;

    if (route?.enabled) {
      const { data: connection, error: connectionError } = await supabase.from("api_connections")
        .select("id,label,base_url,encrypted_key,api_format,enabled,legacy_provider")
        .eq("id", route.connection_id).eq("user_id", userId).maybeSingle();
      if (connectionError && !isMissingApiFoundation(connectionError)) throw connectionError;
      if (connection?.enabled) {
        return {
          name: connectionKind(connection),
          type: connection.api_format === "anthropic" ? "anthropic" : "openai-compatible",
          endpoint: modelEndpoint(connection.base_url, connection.api_format),
          apiKey: decryptSecret(connection.encrypted_key),
          connectionId: connection.id,
          model: route.model_id,
        };
      }
    }
  }

  const provider = getModelProvider(legacyModel);
  if (userId) {
    const { data: credential } = await supabase.from("model_credentials").select("encrypted_key")
      .eq("user_id", userId).eq("provider", provider.name).maybeSingle();
    if (credential?.encrypted_key) provider.apiKey = decryptSecret(credential.encrypted_key);
  }
  return { ...provider, connectionId: null, model: legacyModel };
}

async function getEmbeddingTarget(userId) {
  const { data: route, error: routeError } = await supabase.from("api_feature_routes")
    .select("connection_id,model_id,enabled").eq("user_id", userId).eq("purpose", "embedding").maybeSingle();
  if (routeError && !isMissingApiFoundation(routeError)) throw routeError;
  if (!route?.enabled || !route.connection_id || !route.model_id) return null;
  const { data: connection, error: connectionError } = await supabase.from("api_connections")
    .select("id,label,base_url,encrypted_key,api_format,enabled").eq("id", route.connection_id).eq("user_id", userId).maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection?.enabled || connection.api_format !== "openai_compatible") return null;
  return {
    name: connectionKind(connection), connectionId: connection.id, model: route.model_id,
    endpoint: embeddingEndpoint(connection.base_url, connection.api_format), apiKey: decryptSecret(connection.encrypted_key),
  };
}

async function recordModelUsage(event) {
  try {
    const { error } = await supabase.from("api_usage_events").insert(event);
    if (error) console.error("API usage ledger write failed:", error.code || "database_error");
  } catch {
    console.error("API usage ledger write failed: unexpected_error");
  }
}

async function callEmbeddings({ userId, inputs, target }) {
  const startedAt = new Date(); const startedClock = Date.now(); let response; let payload = {}; let status = "failed";
  try {
    if (!target?.apiKey) throw new Error("Embedding connection is not configured");
    response = await fetch(target.endpoint, {
      method:"POST", redirect:"error",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${target.apiKey}`},
      body:JSON.stringify({model:target.model,input:inputs}),
    });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "Embedding request failed");
    const vectors = [...(payload.data || [])].sort((left,right)=>left.index-right.index).map((item)=>item.embedding);
    if (vectors.length !== inputs.length || vectors.some((vector)=>!Array.isArray(vector) || !vector.length)) {
      throw new Error("Embedding response did not contain one vector per source message");
    }
    status = "succeeded"; return vectors;
  } finally {
    const usage = normalizeModelUsage(target?.name, payload);
    await recordModelUsage({
      user_id:userId,connection_id:target?.connectionId||null,purpose:"embedding",provider:target?.name||null,
      requested_model:target?.model||null,resolved_model:payload.model||target?.model||null,status,http_status:response?.status||null,
      error_code:status==="failed"?(response?.status?`http_${response.status}`:"local_error"):null,
      input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,total_tokens:usage.totalTokens,
      cache_read_tokens:0,cache_write_tokens:0,cache_write_1h_tokens:0,cache_hit_tokens:0,cache_miss_tokens:0,
      reasoning_tokens:0,provider_cost:usage.providerCost,cost_currency:usage.costCurrency,cost_source:usage.costSource,
      duration_ms:Math.max(0,Date.now()-startedClock),preparation_ms:null,first_token_ms:null,
      provider_request_id:payload.id||response?.headers?.get("x-request-id")||null,
      started_at:startedAt.toISOString(),completed_at:new Date().toISOString(),provider_usage:usage.providerUsage,
    });
  }
}

async function validatePublicConnectionUrl(value) {
  const baseUrl = normalizeBaseUrl(value);
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Connection URL resolves to a local or private address");
  }
  return baseUrl;
}

async function callModel({ model, messages, temperature, maxTokens, userId, sessionId, responseFormat, thinking, purpose = "unspecified", onDelta, onCompletion, signal, preparationMs = null }) {
  const startedAt = new Date();
  const startedClock = Date.now();
  let provider;
  let response;
  let responseData = {};
  let status = "failed";
  let errorCode = null;
  let resolvedModel = null;
  let providerRequestId = null;
  let firstTokenMs = null;
  let completion = null;

  try {
    provider = await getModelTarget({ userId, purpose, legacyModel: model });
    model = provider.model;
    if (!provider.apiKey) throw new Error(`${provider.name} API key is not configured. Add it in Settings.`);
    const providerMessages = prepareMessagesForProvider(messages, {
      providerName: provider.name,
      model,
    });

    if (provider.type === "openai-compatible") {
      response = await fetch(provider.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: providerMessages,
          ...(provider.name === "openrouter" && sessionId ? { session_id: sessionId } : {}),
          ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
          ...(provider.name === "deepseek" && thinking ? { thinking: { type: thinking } } : {}),
          ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal,
      });

      if (onDelta && response.ok) {
        const streamed = await readModelEventStream(response, { providerType: provider.type, onDelta: (delta, complete) => {
          if (firstTokenMs === null) firstTokenMs = Math.max(0, (preparationMs || 0) + Date.now() - startedClock);
          onDelta(delta, complete);
        } });
        responseData = streamed.data;
        completion = streamed.completion;
        onCompletion?.(completion);
        const text = streamed.text;
        if (!text) { errorCode = "empty_reply"; throw new Error(`${provider.name} returned an empty streamed reply`); }
        status = completion.complete ? "succeeded" : "truncated";
        resolvedModel = responseData.model || model;
        providerRequestId = responseData.id || response.headers.get("x-request-id");
        return text;
      }
      responseData = await response.json();
      errorCode = apiErrorCode(responseData, response.status);
      if (!response.ok) throw new Error(responseData.error?.message || `${provider.name} request failed`);
      const text = responseData.choices?.[0]?.message?.content?.trim();
      const finishReason = responseData.choices?.[0]?.finish_reason || "unknown";
      completion = normalizeCompletion(provider.type, finishReason, Boolean(responseData.choices?.[0]?.finish_reason));
      onCompletion?.(completion);
      if (responseFormat && finishReason === "length") {
        errorCode = "incomplete_structured_reply";
        throw new Error(`${provider.name} returned an incomplete structured reply`);
      }
      if (!text) {
        errorCode = "empty_reply";
        throw new Error(`${provider.name} returned an empty reply (finish_reason: ${finishReason})`);
      }
      status = completion.complete ? "succeeded" : "truncated";
      errorCode = null;
      resolvedModel = responseData.model || model;
      providerRequestId = responseData.id || response.headers.get("x-request-id");
      return text;
    }

    const system = providerMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const conversation = providerMessages
      .filter((message) => message.role !== "system")
      .map(({ role, content }) => ({ role, content }));

    response = await fetch(provider.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system,
        temperature,
        max_tokens: maxTokens,
        messages: conversation,
        ...(onDelta ? { stream: true } : {}),
      }),
      signal,
    });

    if (onDelta && response.ok) {
      const streamed = await readModelEventStream(response, { providerType: provider.type, onDelta: (delta, complete) => {
        if (firstTokenMs === null) firstTokenMs = Math.max(0, (preparationMs || 0) + Date.now() - startedClock);
        onDelta(delta, complete);
      } });
      responseData = streamed.data;
      completion = streamed.completion;
      onCompletion?.(completion);
      const text = streamed.text;
      if (!text) { errorCode = "empty_reply"; throw new Error("Anthropic returned an empty streamed reply"); }
      status = completion.complete ? "succeeded" : "truncated";
      resolvedModel = responseData.model || model;
      providerRequestId = responseData.id || response.headers.get("request-id");
      return text;
    }
    responseData = await response.json();
    errorCode = apiErrorCode(responseData, response.status);
    if (!response.ok) throw new Error(responseData.error?.message || "Anthropic request failed");
    const text = responseData.content?.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
    completion = normalizeCompletion(provider.type, responseData.stop_reason, Boolean(responseData.stop_reason));
    onCompletion?.(completion);
    if (!text) {
      errorCode = "empty_reply";
      throw new Error("Anthropic returned an empty reply");
    }
    status = completion.complete ? "succeeded" : "truncated";
    errorCode = null;
    resolvedModel = responseData.model || model;
    providerRequestId = responseData.id || response.headers.get("request-id");
    return text;
  } catch (error) {
    error.modelFailure = {
      code: errorCode || null,
      httpStatus: response?.status || null,
    };
    throw error;
  } finally {
    if (userId) {
      const usage = normalizeModelUsage(provider?.name, responseData);
      await recordModelUsage({
        user_id: userId,
        connection_id: provider?.connectionId || null,
        purpose,
        provider: provider?.name || null,
        requested_model: model,
        resolved_model: resolvedModel,
        status,
        http_status: response?.status || null,
        error_code: status === "failed"
          ? (errorCode || (response?.status ? `http_${response.status}` : "local_error"))
          : null,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cache_write_1h_tokens: usage.cacheWrite1hTokens,
        cache_hit_tokens: usage.cacheHitTokens,
        cache_miss_tokens: usage.cacheMissTokens,
        reasoning_tokens: usage.reasoningTokens,
        provider_cost: usage.providerCost,
        cost_currency: usage.costCurrency,
        cost_source: usage.costSource,
        duration_ms: Math.max(0, Date.now() - startedClock),
        preparation_ms: Number.isFinite(preparationMs) ? Math.max(0, Math.trunc(preparationMs)) : null,
        first_token_ms: firstTokenMs,
        provider_request_id: providerRequestId,
        completion_status: completion?.status || null,
        finish_reason: completion?.finishReason || null,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        provider_usage: usage.providerUsage,
      });
    }
  }
}

module.exports = {
  MODEL_PROVIDERS,
  MODEL_CATALOG_TTL_MS,
  modelCatalogCache,
  get openRouterPricingCache() { return openRouterPricingCache; },
  set openRouterPricingCache(value) { openRouterPricingCache = value; },
  getModelProvider,
  isMissingApiFoundation,
  getModelTarget,
  getEmbeddingTarget,
  callModel,
  callEmbeddings,
  recordModelUsage,
  validatePublicConnectionUrl,
};
