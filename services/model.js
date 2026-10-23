const { performance } = require("node:perf_hooks");
const { prepareMessagesForProvider } = require("../core/promptCaching");
const { apiErrorCode, normalizeModelUsage } = require("../core/apiUsage");
const { normalizeCompletion, readModelEventStream } = require("../core/modelStream");
const { createCacheKeepAlive } = require("../core/cacheKeepAlive");

const { getModelTarget, recordModelUsage } = require("./auth");

const promptCacheKeepAlive = createCacheKeepAlive({
  send: ({ userId, sessionId, model, temperature, prefix }) => callModel({
    purpose: "cache_keepalive",
    model,
    temperature,
    thinking: "disabled",
    maxTokens: 1,
    messages: [...prefix, { role: "user", content: "." }],
    userId,
    sessionId,
    modelTargetPromise: getModelTarget({ userId, purpose: "companion_chat", legacyModel: model }),
  }),
});

async function callModel({ model, messages, temperature, maxTokens, userId, sessionId, responseFormat, thinking, purpose = "unspecified", onDelta, onCompletion, signal, preparationMs = null, timing, onUsage, modelTargetPromise }) {
  const startedAt = new Date();
  const startedClock = performance.now();
  const endUpstream = timing?.start("upstream_request");
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
    provider = await (modelTargetPromise || getModelTarget({ userId, purpose, legacyModel: model }));
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

      endUpstream?.(response.ok);
      if (onDelta && response.ok) {
        const streamed = await readModelEventStream(response, { providerType: provider.type, onDelta: (delta, complete) => {
          if (firstTokenMs === null) {
            firstTokenMs = timing ? timing.mark("upstream_first_token") : Math.max(0, (preparationMs || 0) + performance.now() - startedClock);
          }
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

    endUpstream?.(response.ok);
    if (onDelta && response.ok) {
      const streamed = await readModelEventStream(response, { providerType: provider.type, onDelta: (delta, complete) => {
        if (firstTokenMs === null) {
          firstTokenMs = timing ? timing.mark("upstream_first_token") : Math.max(0, (preparationMs || 0) + performance.now() - startedClock);
        }
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
    endUpstream?.(false);
    if (userId) {
      const usage = normalizeModelUsage(provider?.name, responseData);
      const usageEvent = {
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
        duration_ms: Math.max(0, Math.trunc(performance.now() - startedClock)),
        preparation_ms: Number.isFinite(preparationMs) ? Math.max(0, Math.trunc(preparationMs)) : null,
        first_token_ms: Number.isFinite(firstTokenMs) ? Math.max(0, Math.trunc(firstTokenMs)) : null,
        provider_request_id: providerRequestId,
        completion_status: completion?.status || null,
        finish_reason: completion?.finishReason || null,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        provider_usage: usage.providerUsage,
      };
      if (onUsage) onUsage(usageEvent);
      else await recordModelUsage(usageEvent);
    }
  }
}

async function createTitle(model, message, reply, userId) {
  const fallback = message.slice(0, 16);

  try {
    return (await callModel({
      purpose: "conversation_title",
      model,
      temperature: 0.3,
      maxTokens: 20,
      thinking: "disabled",
      userId,
      messages: [{
        role: "user",
        content: `Create a concise title for this conversation. Return only the title, with no quotes, in at most 12 words.\nUser: ${message}\nAssistant: ${reply}`,
      }],
    })).slice(0, 48) || fallback;
  } catch (error) {
    console.error("Title generation failed:", error);
    return fallback;
  }
}

module.exports = { callModel, createTitle, promptCacheKeepAlive };
