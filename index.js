const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dns = require("node:dns").promises;
const { createClient } = require("@supabase/supabase-js");
const {
  buildModelContext,
  buildModelContextLayers,
  estimateTokens,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
} = require("./core/context");
const { prepareMessagesForProvider } = require("./core/promptCaching");
const { calculateUsageCosts, deepSeekPricingForEvent, normalizeOpenRouterPricing, shanghaiPeriodStarts } = require("./core/usageCosts");
const {
  MEMORY_CATEGORIES,
  formatLongTermMemories,
  parseExplicitMemoryRequest,
  parseMemoryExtraction,
  rankMemories,
  splitTriggers,
} = require("./core/memory");
const { buildSemanticEventPrompt, parseSemanticEventDecision } = require("./core/eventInterpreter");
const {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_CONTENT,
  DOCUMENT_TYPES,
  LOAD_MODES,
  CONFIRMATION_STATUSES,
  formatPromptDocuments,
  formatRetrievedPromptDocuments,
  selectRelevantPromptDocuments,
} = require("./core/promptDocuments");
const { formatTimelineEntries, normalizeEvidenceTerms, selectRelevantTimeline } = require("./core/timeline");
const { buildHandoffPrompt, formatWindowContinuity, parseHandoffCandidate } = require("./core/handoff");
const { cleanClaudeSay, normalizeClaudeExport, parseTimelineCandidates, segmentClaudeMessages } = require("./core/claudeImport");
const { groupSourceMessagesBySharedDay, hasMorningMarker, hasNightMarker } = require("./core/sharedDays");
const { buildGroundedDiaryPrompt, parseGroundedDiary, validateGroundedDiary } = require("./core/groundedDiary");
const { applyDiaryReview, cleanText, reviewEventForAction } = require("./core/diaryReview");
const { classifyDiaryGenerationError } = require("./core/diaryFailures");
const { buildRetrievalWindows, formatSharedDayRecall, lexicalCandidateAccepted, rankSharedDays, retrievalQueryTerms, selectSourceExcerpt, shouldContinueRecallPointer } = require("./core/sourceRecall");
const {
  buildExperienceExtractionPrompt,
  buildDocumentMergePrompt,
  buildImportDistillationPrompt,
  buildSupportExtractionPrompt,
  buildVerificationPrompt,
  parseExperienceExtraction,
  parseDocumentMerge,
  parseImportDistillation,
  parseMemoryVerification,
  parseSupportExtraction,
} = require("./core/memoryPractice");
const { apiErrorCode, normalizeModelUsage } = require("./core/apiUsage");
const { normalizeCompletion, readModelEventStream } = require("./core/modelStream");
const {
  API_FORMATS,
  FEATURE_DEFINITIONS,
  FEATURE_PURPOSES,
  connectionKind,
  embeddingEndpoint,
  isPrivateIp,
  modelCatalogEndpoint,
  modelEndpoint,
  normalizeBaseUrl,
  normalizeModelCatalog,
  safeConnectionView,
} = require("./core/apiConnections");
const {
  FOLLOW_UP_KINDS,
  FOLLOW_UP_STATUSES,
  formatFollowUps,
  parseExplicitFollowUpRequest,
  selectRelevantFollowUps,
  selectStatusRelevantFollowUps,
  selectContextualFollowUps,
  suggestFollowUpStatus,
} = require("./core/followup");

require("dotenv").config();

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be configured on the server");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const modelCatalogCache = new Map();
let openRouterPricingCache = { loadedAt: 0, prices: new Map() };

const DEFAULT_SETTINGS = {
  system_prompt: "You are a warm, thoughtful AI companion. Respond naturally and supportively.",
  model: "deepseek-v4-flash",
  temperature: 0.8,
  max_tokens: 800,
  context_token_threshold: 6000,
  recent_message_limit: 12,
  summary_model: "deepseek-v4-flash",
  timeline_model: "deepseek-v4-flash",
};
const DEFAULT_SESSION_NAME = "New conversation";
function encryptionKey() {
  const key = Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decryptSecret(value) {
  const payload = Buffer.from(value, "base64"); const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28)); return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}


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

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    const isAllowed = !origin
      || origin.endsWith(".vercel.app")
      || origin.startsWith("http://localhost:")
      || allowedOrigins.includes(origin);
    callback(isAllowed ? null : new Error("Origin is not allowed by CORS"), isAllowed);
  },
}));
app.use(express.json({ limit: "2mb" }));

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired session" });
  req.user = data.user;
  next();
}

app.use((req, res, next) => req.path === "/health" ? next() : requireUser(req, res, next));

function toSettings(settings) {
  return {
    systemPrompt: settings.system_prompt,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.max_tokens,
    contextTokenThreshold: settings.context_token_threshold,
    recentMessageLimit: settings.recent_message_limit,
    summaryModel: settings.summary_model,
    timelineModel: settings.timeline_model || settings.summary_model,
  };
}

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

async function recordModelUsage(event) {
  try {
    const { error } = await supabase.from("api_usage_events").insert(event);
    if (error) console.error("API usage ledger write failed:", error.code || "database_error");
  } catch {
    console.error("API usage ledger write failed: unexpected_error");
  }
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

async function maybeCompressMemory(sessionId, settings, userId) {
  const { data: memory, error: memoryError } = await supabase
    .from("session_memories")
    .select("summary, last_compressed_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (memoryError) throw memoryError;

  const { data: allMessages, error: messagesError } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .eq("is_visible", true)
    .eq("context_status", "active")
    .order("created_at", { ascending: true });
  if (messagesError) throw messagesError;

  const approximateTokens = estimateTokens(settings.system_prompt)
    + estimateTokens(memory?.summary)
    + allMessages.reduce((total, item) => total + estimateTokens(item.content), 0);
  const recentMessageLimit = normalizeRecentMessageLimit(settings.recent_message_limit);

  if (approximateTokens <= settings.context_token_threshold || allMessages.length <= recentMessageLimit) {
    return memory?.summary;
  }

  const retainedMessages = allMessages.slice(-recentMessageLimit);
  const retainedBoundary = retainedMessages[0]?.created_at;
  const messagesToCompress = allMessages.filter((item) =>
    item.created_at < retainedBoundary
    && (!memory?.last_compressed_at || item.created_at > memory.last_compressed_at)
  );

  if (!messagesToCompress.length) return memory?.summary;

  const transcript = messagesToCompress
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n");
  const summary = await callModel({
    purpose: "conversation_summary",
    model: settings.summary_model,
    temperature: 0.2,
    maxTokens: 500,
    userId,
    messages: [{
      role: "system",
      content: "Maintain a compact factual memory for an AI companion. Preserve user preferences, important events, relationship context, commitments, and unresolved topics. Do not invent details.",
    }, {
      role: "user",
      content: `Existing memory summary:\n${memory?.summary || "(none)"}\n\nNew conversation to merge:\n${transcript}`,
    }],
  });

  const lastCompressedAt = messagesToCompress.at(-1).created_at;
  const { error: saveError } = await supabase
    .from("session_memories")
    .upsert({
      session_id: sessionId,
      summary,
      last_compressed_at: lastCompressedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "session_id" });
  if (saveError) throw saveError;

  return summary;
}

async function getSettings(userId) {
  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: createError } = await supabase
    .from("user_settings")
    .upsert({ user_id: userId, ...DEFAULT_SETTINGS }, { onConflict: "user_id" })
    .select()
    .single();

  if (createError) throw createError;
  return created;
}

async function getOrCreateDefaultCharacter(userId) {
  const { data, error } = await supabase
    .from("characters")
    .select("*")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: created, error: createError } = await supabase
    .from("characters")
    .insert({ user_id: userId, is_default: true })
    .select()
    .single();
  if (createError) throw createError;
  return created;
}

async function getOrCreateUserProfile(userId) {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: created, error: createError } = await supabase
    .from("user_profiles")
    .insert({ user_id: userId })
    .select()
    .single();
  if (createError) throw createError;
  return created;
}

async function getOwnedCharacter(characterId, userId) {
  const { data, error } = await supabase
    .from("characters")
    .select("*")
    .eq("id", characterId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) { const missing = new Error("Character not found"); missing.status = 404; throw missing; }
  return data;
}

async function loadPromptDocuments(userId, characterId) {
  const { data, error } = await supabase.from("prompt_documents").select("*")
    .eq("user_id", userId).eq("character_id", characterId)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadRelevantTimeline(userId, characterId, currentMessage) {
  const { data, error } = await supabase.from("timeline_entries").select("*")
    .eq("user_id", userId).eq("character_id", characterId).eq("status", "active")
    .order("occurred_at", { ascending: false }).limit(300);
  if (error) throw error;
  const selected = selectRelevantTimeline(data || [], currentMessage, 5);
  if (selected.length) {
    await Promise.all(selected.map((entry) => supabase.from("timeline_entries").update({
      recall_count: (entry.recall_count || 0) + 1,
      last_recalled_at: new Date().toISOString(),
    }).eq("id", entry.id).eq("user_id", userId)));
  }
  return selected;
}

async function loadWindowContinuity(userId, session) {
  if (!session?.handoff_id) return { handoff: null, tailMessages: [] };
  const { data: handoff, error } = await supabase.from("session_handoffs").select("*")
    .eq("id", session.handoff_id).eq("user_id", userId).eq("status", "confirmed").maybeSingle();
  if (error) throw error;
  if (!handoff) return { handoff: null, tailMessages: [] };
  const ids = handoff.tail_message_ids || [];
  if (!ids.length) return { handoff, tailMessages: [] };
  const { data: messages, error: messagesError } = await supabase.from("messages")
    .select("id, role, content, created_at").in("id", ids)
    .order("created_at", { ascending: true });
  if (messagesError) throw messagesError;
  return { handoff, tailMessages: messages || [] };
}

async function createSession(userId, name = DEFAULT_SESSION_NAME, characterId) {
  const character = characterId
    ? await getOwnedCharacter(characterId, userId)
    : await getOrCreateDefaultCharacter(userId);
  const { data: latestHandoff, error: handoffError } = await supabase.from("session_handoffs").select("id")
    .eq("user_id", userId).eq("character_id", character.id).eq("status", "confirmed")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (handoffError) throw handoffError;
  const { data, error } = await supabase
    .from("sessions")
    .insert({ name, user_id: userId, character_id: character.id, handoff_id: latestHandoff?.id || null })
    .select("id, name, character_id, handoff_id, created_at, updated_at")
    .single();

  if (error) throw error;
  return data;
}

async function touchSession(sessionId, userId) {
  const { error } = await supabase
    .from("sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", userId);

  if (error) throw error;
}

async function requireOwnedSession(sessionId, userId) {
  const { data, error } = await supabase.from("sessions").select("id, character_id, handoff_id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) { const missing = new Error("Session not found"); missing.status = 404; throw missing; }
  return data;
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

async function recallMemories(userId, characterId, currentMessage) {
  const { data, error } = await supabase.from("memories").select("*")
    .eq("user_id", userId).eq("character_id", characterId).eq("status", "active")
    .order("updated_at", { ascending: false }).limit(200);
  if (error) throw error;
  const selected = rankMemories(data || [], currentMessage, 5);
  if (selected.length) {
    await Promise.all(selected.map((memory) => supabase.from("memories").update({
      recall_count: (memory.recall_count || 0) + 1,
      last_recalled_at: new Date().toISOString(),
    }).eq("id", memory.id).eq("user_id", userId)));
  }
  return selected;
}

async function loadStatusFollowUps(userId, characterId) {
  const { data, error } = await supabase.from("follow_ups").select("*")
    .eq("user_id", userId).eq("character_id", characterId)
    .neq("status", "cancelled")
    .order("updated_at", { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}

async function interpretSemanticEvent({ userId, settings, message, recentMessages, followUps }) {
  const localDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
  }).format(new Date()) + " Asia/Shanghai";
  const raw = await callModel({
    purpose: "followup_interpretation",
    model: settings.summary_model,
    temperature: 0,
    maxTokens: 450,
    thinking: "disabled",
    userId,
    messages: [
      { role: "system", content: "You extract structured relationship-continuity events. Follow the schema exactly and never invent a topic." },
      { role: "user", content: buildSemanticEventPrompt({
        currentMessage: message, recentMessages, followUps, localDate,
      }) },
    ],
  });
  return parseSemanticEventDecision(raw, followUps);
}
async function extractLongTermMemories({ userId, character, userProfile, sessionId, message, reply, settings }) {
  const { data: existing, error: existingError } = await supabase.from("memories")
    .select("content").eq("user_id", userId).eq("character_id", character.id)
    .neq("status", "deleted").order("updated_at", { ascending: false }).limit(50);
  if (existingError) throw existingError;

  const extractionPrompt = [
    "Extract only durable, explicitly supported memories from this single exchange.",
    "Allowed categories: preference, important_event, promise, relationship.",
    "Do not turn temporary moods, guesses, ordinary questions, or routine pleasantries into lasting facts.",
    "Do not store follow-up lifecycle states such as active, waiting, paused, or when to revisit; the follow-up module owns those.",
    "A durable real-world outcome may be stored as important_event, but never attach workflow status to the memory.",
    "Use third person and the provided names. Return a JSON array only.",
    'Each item: {"category":"...","content":"...","triggers":["1-3 specific recall phrases"]}.',
    "Return [] when nothing is worth retaining. Maximum 2 items.",
    `Character name: ${character.name || "Companion"}`,
    `User name: ${userProfile.display_name || "the user"}`,
    `Existing memories (do not duplicate):\n${(existing || []).map((item) => `- ${item.content}`).join("\n") || "(none)"}`,
  ].join("\n\n");

  const raw = await callModel({
    purpose: "long_term_memory_extraction",
    model: settings.summary_model,
    temperature: 0.1,
    maxTokens: 350,
    thinking: "disabled",
    userId,
    messages: [
      { role: "system", content: extractionPrompt },
      { role: "user", content: `User: ${message}\nAssistant: ${reply}` },
    ],
  });
  const candidates = parseMemoryExtraction(raw);
  if (!candidates.length) return;

  const normalizedExisting = new Set((existing || []).map((item) => item.content.trim().toLocaleLowerCase()));
  const rows = candidates.filter((item) => !normalizedExisting.has(item.content.toLocaleLowerCase())).map((item) => ({
    ...item,
    user_id: userId,
    character_id: character.id,
    source_session_id: sessionId,
  }));
  if (!rows.length) return;
  const { error } = await supabase.from("memories").insert(rows);
  if (error) throw error;
}

async function saveExplicitMemory({ userId, characterId, sessionId, candidate }) {
  const { data: existing, error: existingError } = await supabase.from("memories")
    .select("id, content, triggers, status, is_permanent")
    .eq("user_id", userId).eq("character_id", characterId)
    .neq("status", "deleted").order("updated_at", { ascending: false }).limit(100);
  if (existingError) throw existingError;

  const normalized = candidate.content.trim().toLocaleLowerCase();
  const duplicate = (existing || []).find((memory) => memory.content.trim().toLocaleLowerCase() === normalized);
  if (duplicate) {
    const { data, error } = await supabase.from("memories").update({
      triggers: splitTriggers([...(duplicate.triggers || []), ...candidate.triggers], 6),
      status: "active",
      is_permanent: candidate.is_permanent === true || duplicate.is_permanent,
      updated_at: new Date().toISOString(),
    }).eq("id", duplicate.id).eq("user_id", userId).select().single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase.from("memories").insert({
    ...candidate,
    user_id: userId,
    character_id: characterId,
    source_session_id: sessionId,
  }).select().single();
  if (error) throw error;
  return data;
}

async function saveExplicitFollowUp({ userId, characterId, sessionId, candidate }) {
  const { data: existing, error: existingError } = await supabase.from("follow_ups")
    .select("id, title, content, status")
    .eq("user_id", userId).eq("character_id", characterId)
    .in("status", ["active", "waiting", "paused"])
    .order("updated_at", { ascending: false }).limit(100);
  if (existingError) throw existingError;
  const normalizedTitle = candidate.title.trim().toLocaleLowerCase();
  const duplicate = (existing || []).find((item) => item.title.trim().toLocaleLowerCase() === normalizedTitle);
  if (duplicate) return duplicate;

  const { data, error } = await supabase.from("follow_ups").insert({
    ...candidate,
    user_id: userId,
    character_id: characterId,
    source_session_id: sessionId,
  }).select().single();
  if (error) throw error;
  return data;
}

app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "AI Lover Backend is running" });
});

function textUpdate(body, key, maxLength = 4000) {
  return typeof body[key] === "string" ? body[key].trim().slice(0, maxLength) : undefined;
}

app.get("/character", async (req, res) => {
  try {
    res.json({ success: true, character: await getOrCreateDefaultCharacter(req.user.id) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/character", async (req, res) => {
  const current = await getOrCreateDefaultCharacter(req.user.id).catch((error) => null);
  if (!current) return res.status(500).json({ success: false, error: "Could not load character" });
  const updates = {};
  for (const [key, max] of [
    ["name", 80], ["identity", 1000], ["personality", 3000],
    ["speech_style", 2000], ["initiative_style", 2000],
    ["conflict_style", 2000], ["boundaries", 3000],
  ]) {
    const value = textUpdate(req.body, key, max);
    if (value !== undefined) updates[key] = value;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No character fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("characters").update(updates)
    .eq("id", current.id).eq("user_id", req.user.id).select().single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, character: data });
});

app.get("/profile", async (req, res) => {
  try {
    res.json({ success: true, profile: await getOrCreateUserProfile(req.user.id) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/profile", async (req, res) => {
  try {
    await getOrCreateUserProfile(req.user.id);
    const updates = {};
    for (const [key, max] of [
      ["display_name", 80], ["pronouns", 80], ["bio", 3000],
      ["communication_preferences", 3000], ["boundaries", 3000],
    ]) {
      const value = textUpdate(req.body, key, max);
      if (value !== undefined) updates[key] = value;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No profile fields were provided" });
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("user_profiles").update(updates)
      .eq("user_id", req.user.id).select().single();
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/prompt-documents", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    res.json({ success: true, documents: await loadPromptDocuments(req.user.id, character.id) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/prompt-documents", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const existing = await loadPromptDocuments(req.user.id, character.id);
    if (existing.length >= MAX_DOCUMENTS) {
      return res.status(400).json({ success: false, error: `A companion can have at most ${MAX_DOCUMENTS} prompt documents` });
    }
    const name = textUpdate(req.body, "name", 120);
    const content = textUpdate(req.body, "content", MAX_DOCUMENT_CONTENT);
    if (!name || !content) return res.status(400).json({ success: false, error: "Document name and Markdown content are required" });
    const documentType = DOCUMENT_TYPES.has(req.body.documentType) ? req.body.documentType : "topic";
    const loadMode = LOAD_MODES.has(req.body.loadMode) ? req.body.loadMode : "always";
    const confirmationStatus = CONFIRMATION_STATUSES.has(req.body.confirmationStatus)
      ? req.body.confirmationStatus : "confirmed";
    const nextOrder = existing.reduce((maximum, item) => Math.max(maximum, item.sort_order), -1) + 1;
    const { data, error } = await supabase.from("prompt_documents").insert({
      user_id: req.user.id,
      character_id: character.id,
      name,
      content,
      sort_order: nextOrder,
      is_enabled: loadMode !== "archive" && req.body.isEnabled !== false,
      document_type: documentType,
      load_mode: loadMode,
      confirmation_status: confirmationStatus,
      created_by: req.body.createdBy === "ai" ? "ai" : "user",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, document: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/prompt-documents/:documentId", async (req, res) => {
  const updates = {};
  const name = textUpdate(req.body, "name", 120);
  const content = textUpdate(req.body, "content", MAX_DOCUMENT_CONTENT);
  if (name !== undefined) updates.name = name;
  if (content !== undefined) updates.content = content;
  if (DOCUMENT_TYPES.has(req.body.documentType)) updates.document_type = req.body.documentType;
  if (LOAD_MODES.has(req.body.loadMode)) {
    updates.load_mode = req.body.loadMode;
    updates.is_enabled = req.body.loadMode !== "archive";
  } else if (typeof req.body.isEnabled === "boolean") {
    updates.is_enabled = req.body.isEnabled;
    updates.load_mode = req.body.isEnabled ? "always" : "archive";
  }
  if (CONFIRMATION_STATUSES.has(req.body.confirmationStatus)) {
    updates.confirmation_status = req.body.confirmationStatus;
  }
  if (updates.name === "" || updates.content === "") {
    return res.status(400).json({ success: false, error: "Document name and Markdown content cannot be empty" });
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No document fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("prompt_documents").update(updates)
    .eq("id", req.params.documentId).eq("user_id", req.user.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Prompt document not found" });
  res.json({ success: true, document: data });
});

app.put("/prompt-documents/order", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const ids = Array.isArray(req.body.documentIds) ? req.body.documentIds : [];
    const documents = await loadPromptDocuments(req.user.id, character.id);
    if (ids.length !== documents.length || new Set(ids).size !== ids.length
        || documents.some((document) => !ids.includes(document.id))) {
      return res.status(400).json({ success: false, error: "Document order must contain every document exactly once" });
    }
    for (const [sortOrder, id] of ids.entries()) {
      const { error } = await supabase.from("prompt_documents").update({
        sort_order: sortOrder, updated_at: new Date().toISOString(),
      }).eq("id", id).eq("user_id", req.user.id).eq("character_id", character.id);
      if (error) throw error;
    }
    res.json({ success: true, documents: await loadPromptDocuments(req.user.id, character.id) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.delete("/prompt-documents/:documentId", async (req, res) => {
  const { data, error } = await supabase.from("prompt_documents").delete()
    .eq("id", req.params.documentId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Prompt document not found" });
  res.status(204).end();
});

app.get("/prompt-documents/:documentId/versions", async (req, res) => {
  const { data: document, error: documentError } = await supabase.from("prompt_documents").select("id")
    .eq("id", req.params.documentId).eq("user_id", req.user.id).maybeSingle();
  if (documentError) return res.status(500).json({ success: false, error: documentError.message });
  if (!document) return res.status(404).json({ success: false, error: "Prompt document not found" });
  const { data, error } = await supabase.from("prompt_document_versions").select("*")
    .eq("document_id", document.id).eq("user_id", req.user.id)
    .order("version", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, versions: data || [] });
});

function limitedStrings(value, limit = 20, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim())
    .filter(Boolean).map((item) => item.slice(0, maxLength)))].slice(0, limit);
}

async function ownedMessageIds(value, sessionId, limit = 20) {
  const ids = limitedStrings(value, limit, 64);
  if (!ids.length) return [];
  if (!sessionId) {
    const error = new Error("Source messages require an owned source session");
    error.status = 400;
    throw error;
  }
  const { data, error } = await supabase.from("messages").select("id")
    .eq("session_id", sessionId).in("id", ids);
  if (error) throw error;
  if ((data || []).length !== ids.length) {
    const ownershipError = new Error("Every source message must belong to the source session");
    ownershipError.status = 400;
    throw ownershipError;
  }
  return ids;
}

app.get("/timeline-imports", async (req, res) => {
  const { data, error } = await supabase.from("conversation_imports").select("*")
    .eq("user_id", req.user.id).neq("status", "deleted").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, imports: data || [] });
});

app.post("/timeline-imports", async (req, res) => {
  let createdImport;
  try {
    const character = req.body.characterId ? await getOwnedCharacter(req.body.characterId, req.user.id) : await getOrCreateDefaultCharacter(req.user.id);
    const messages = normalizeClaudeExport(req.body.exportData).map((message, index) => ({
      ...message, sourceMessageId: crypto.randomUUID(), sourcePosition: index + 1,
    }));
    if (messages.length > 10000) return res.status(400).json({ success: false, error: "An export can contain at most 10,000 messages" });
    const segments = segmentClaudeMessages(messages);
    const title = String(req.body.exportData?.metadata?.title || req.body.sourceFilename || "Claude import").slice(0, 160);
    const { data, error } = await supabase.from("conversation_imports").insert({
      user_id: req.user.id, character_id: character.id, title,
      source_filename: String(req.body.sourceFilename || "claude-export.json").slice(0, 255),
      source_metadata: req.body.exportData?.metadata || {}, message_count: messages.length,
      character_count: messages.reduce((sum, item) => sum + item.raw.length, 0), segment_count: segments.length,
    }).select().single();
    if (error) throw error;
    createdImport = data;
    const rows = segments.map((segment) => ({
      import_id: data.id, user_id: req.user.id, character_id: character.id, sequence: segment.sequence,
      started_at: segment.startedAt, ended_at: segment.endedAt, message_count: segment.messageCount,
      character_count: segment.charCount, raw_messages: segment.rawMessages, cleaned_transcript: segment.transcript,
    }));
    const { data: savedSegments, error: segmentError } = await supabase.from("imported_conversation_segments").insert(rows).select("id,sequence,started_at,ended_at,message_count,character_count,status");
    if (segmentError) throw segmentError;
    const segmentIds = new Map(savedSegments.map((segment) => [segment.sequence, segment.id]));
    const sourceRows = rows.flatMap((segment) => segment.raw_messages.map((source, index) => ({
      id: source.source_message_id,
      user_id: req.user.id,
      character_id: character.id,
      source_kind: "claude_import",
      revision_kind: "original",
      role: source.role,
      raw_content: source.content,
      occurred_at: source.time,
      import_id: data.id,
      imported_segment_id: segmentIds.get(segment.sequence),
      revision_number: 0,
      source_position: source.source_position,
      segment_message_index: index + 1,
      source_metadata: { source_filename: String(req.body.sourceFilename || "claude-export.json").slice(0, 255), segment_sequence: segment.sequence },
    })));
    const { error: sourceError } = await supabase.from("source_messages").insert(sourceRows);
    if (sourceError) throw sourceError;
    setImmediate(()=>rebuildSharedLifeDays(req.user.id,character.id).catch((reason)=>console.error("Imported shared-day refresh failed:",reason.message)));
    res.status(201).json({ success: true, import: data, segments: savedSegments });
  } catch (error) {
    if (createdImport?.id) await supabase.from("conversation_imports").delete().eq("id", createdImport.id).eq("user_id", req.user.id);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/timeline-imports/:importId/segments", async (req, res) => {
  const { data, error } = await supabase.from("imported_conversation_segments")
    .select("id,sequence,started_at,ended_at,message_count,character_count,status,timeline_candidates(id,status)")
    .eq("import_id", req.params.importId).eq("user_id", req.user.id).order("sequence");
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, segments: (data || []).map((segment) => ({
    ...segment,
    candidateCount: (segment.timeline_candidates || []).length,
    suggestedCount: (segment.timeline_candidates || []).filter((candidate) => candidate.status === "suggested").length,
    timeline_candidates: undefined,
  })) });
});

app.get("/timeline-segments/:segmentId", async (req, res) => {
  const { data, error } = await supabase.from("imported_conversation_segments").select("*")
    .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Imported segment not found" });
  res.json({ success: true, segment: data });
});

app.post("/timeline-segments/:segmentId/generate", async (req, res) => {
  try {
    const { data: segment, error } = await supabase.from("imported_conversation_segments").select("*")
      .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!segment) return res.status(404).json({ success: false, error: "Imported segment not found" });
    const settings = await getSettings(req.user.id);
    const model = settings.timeline_model || settings.summary_model;
    const sourceMessages = (segment.raw_messages || []).map((message) => ({
      role: message.role,
      content: cleanClaudeSay(message.role, message.content),
    }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");
    const raw = await callModel({
      purpose: "timeline_generation",
      model,
      userId: req.user.id,
      temperature: 0.1,
      maxTokens: 2600,
      responseFormat: "json_object",
      thinking: "disabled",
      messages: [
      { role: "system", content: [
        "You create documentary timeline candidates from an AI-companion conversation segment.",
        "Return JSON only: {\"candidates\":[{\"title\":\"\",\"body_markdown\":\"\",\"current_state\":\"\",\"index_summary\":\"\",\"evidence_message_numbers\":[1,2],\"evidence_terms\":[\"\"]}]}",
        "Create 0-4 candidates. Record only durable experiences, relationship developments, decisions, or meaningful current states.",
        "Do not turn roleplay scenery, speculation, model analysis, or ordinary affectionate filler into real-world facts.",
        "Every factual claim must be supported by evidence_message_numbers that refer to the numbered source messages. Never copy or rewrite evidence text yourself.",
        "current_state must describe how the matter stood at the END of this segment, not an earlier state.",
      ].join("\n") },
      { role: "user", content: `Segment time: ${segment.started_at} to ${segment.ended_at}\n\n${numberedTranscript}` },
      ],
    });
    const candidates = parseTimelineCandidates(raw, numberedTranscript, sourceMessages);
    await supabase.from("timeline_candidates").delete().eq("segment_id", segment.id).eq("user_id", req.user.id).eq("status", "suggested");
    const rows = candidates.map((candidate) => ({
      segment_id: segment.id, user_id: req.user.id, character_id: segment.character_id, model,
      title: candidate.title, body_markdown: candidate.bodyMarkdown, current_state: candidate.currentState,
      index_summary: candidate.indexSummary, evidence_quotes: candidate.evidenceQuotes,
      evidence_terms: normalizeEvidenceTerms(candidate.evidenceTerms, 12),
    }));
    const { data: saved, error: saveError } = rows.length ? await supabase.from("timeline_candidates").insert(rows).select("*") : { data: [], error: null };
    if (saveError) throw saveError;
    await supabase.from("imported_conversation_segments").update({ status: "generated" }).eq("id", segment.id).eq("user_id", req.user.id);
    res.json({ success: true, candidates: saved || [], candidateCount: (saved || []).length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/timeline-candidates", async (req, res) => {
  const { data, error } = await supabase.from("timeline_candidates").select("*")
    .eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, candidates: data || [] });
});

app.patch("/timeline-candidates/:candidateId", async (req, res) => {
  try {
    const { data: candidate, error } = await supabase.from("timeline_candidates").select("*, imported_conversation_segments(cleaned_transcript)")
      .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").maybeSingle();
    if (error) throw error;
    if (!candidate) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
    const updates = {};
    for (const [bodyKey, column, max] of [["title","title",160],["bodyMarkdown","body_markdown",20000],["currentState","current_state",3000],["indexSummary","index_summary",1200]]) {
      const value = textUpdate(req.body, bodyKey, max); if (value !== undefined) updates[column] = value;
    }
    if (Array.isArray(req.body.evidenceTerms) || typeof req.body.evidenceTerms === "string") updates.evidence_terms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
    if (Array.isArray(req.body.evidenceQuotes)) {
      const quotes = limitedStrings(req.body.evidenceQuotes, 6, 2000);
      if (!quotes.length || quotes.some((quote) => !candidate.imported_conversation_segments.cleaned_transcript.includes(quote))) {
        return res.status(400).json({ success: false, error: "Every evidence quote must exist exactly in the source segment" });
      }
      updates.evidence_quotes = quotes;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No candidate fields were provided" });
    if ([updates.title, updates.body_markdown, updates.current_state, updates.index_summary].some((value) => value === "")) return res.status(400).json({ success: false, error: "Candidate fields cannot be empty" });
    const { data: saved, error: saveError } = await supabase.from("timeline_candidates").update(updates)
      .eq("id", candidate.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    res.json({ success: true, candidate: saved });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/timeline-candidates/:candidateId/confirm", async (req, res) => {
  try {
    const { data: candidate, error } = await supabase.from("timeline_candidates").select("*, imported_conversation_segments(ended_at)")
      .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").maybeSingle();
    if (error) throw error;
    if (!candidate) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
    const { data: entry, error: entryError } = await supabase.from("timeline_entries").insert({
      user_id: req.user.id, character_id: candidate.character_id, title: candidate.title,
      body_markdown: candidate.body_markdown, current_state: candidate.current_state,
      index_summary: candidate.index_summary, evidence_terms: candidate.evidence_terms,
      occurred_at: candidate.imported_conversation_segments.ended_at, confirmation_status: "confirmed", created_by: "ai",
    }).select().single();
    if (entryError) throw entryError;
    const { data: reviewed, error: reviewError } = await supabase.from("timeline_candidates").update({
      status: "confirmed", timeline_entry_id: entry.id, reviewed_at: new Date().toISOString(),
    }).eq("id", candidate.id).eq("user_id", req.user.id).select().single();
    if (reviewError) { await supabase.from("timeline_entries").delete().eq("id", entry.id).eq("user_id", req.user.id); throw reviewError; }
    res.json({ success: true, candidate: reviewed, entry });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/timeline-candidates/:candidateId/reject", async (req, res) => {
  const { data, error } = await supabase.from("timeline_candidates").update({ status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
  res.json({ success: true, candidate: data });
});

app.get("/timeline", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("timeline_entries").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .neq("status", "deleted").order("occurred_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, entries: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/timeline", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const title = textUpdate(req.body, "title", 160);
    const bodyMarkdown = textUpdate(req.body, "bodyMarkdown", 20000);
    const currentState = textUpdate(req.body, "currentState", 3000);
    const indexSummary = textUpdate(req.body, "indexSummary", 1200);
    const evidenceTerms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();
    if (!title || !bodyMarkdown || !currentState || !indexSummary || !evidenceTerms.length
        || Number.isNaN(occurredAt.getTime())) {
      return res.status(400).json({ success: false, error: "Title, journal text, current state, index summary, evidence terms, and a valid time are required" });
    }
    let sourceSessionId = null;
    if (req.body.sourceSessionId) {
      const session = await requireOwnedSession(req.body.sourceSessionId, req.user.id);
      if (session.character_id !== character.id) return res.status(400).json({ success: false, error: "Session and timeline entry use different companions" });
      sourceSessionId = session.id;
    }
    const sourceMessageIds = await ownedMessageIds(req.body.sourceMessageIds, sourceSessionId, 20);
    const { data, error } = await supabase.from("timeline_entries").insert({
      user_id: req.user.id,
      character_id: character.id,
      source_session_id: sourceSessionId,
      title,
      body_markdown: bodyMarkdown,
      current_state: currentState,
      index_summary: indexSummary,
      evidence_terms: evidenceTerms,
      source_message_ids: sourceMessageIds,
      occurred_at: occurredAt.toISOString(),
      confirmation_status: req.body.confirmationStatus === "confirmed" ? "confirmed" : "auto",
      created_by: req.body.createdBy === "user" ? "user" : "ai",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, entry: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/timeline/:entryId", async (req, res) => {
  const updates = {};
  for (const [bodyKey, column, max] of [
    ["title", "title", 160], ["bodyMarkdown", "body_markdown", 20000],
    ["currentState", "current_state", 3000], ["indexSummary", "index_summary", 1200],
  ]) {
    const value = textUpdate(req.body, bodyKey, max);
    if (value !== undefined) updates[column] = value;
  }
  if (Array.isArray(req.body.evidenceTerms) || typeof req.body.evidenceTerms === "string") {
    updates.evidence_terms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
  }
  if (["auto", "confirmed"].includes(req.body.confirmationStatus)) {
    updates.confirmation_status = req.body.confirmationStatus;
  }
  if (req.body.occurredAt !== undefined) {
    const occurredAt = new Date(req.body.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ success: false, error: "Invalid time" });
    updates.occurred_at = occurredAt.toISOString();
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No timeline fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("timeline_entries").update(updates)
    .eq("id", req.params.entryId).eq("user_id", req.user.id).neq("status", "deleted")
    .select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Timeline entry not found" });
  res.json({ success: true, entry: data });
});

app.post("/timeline/:entryId/retract", async (req, res) => {
  const quote = textUpdate(req.body, "quote", 2000);
  const reason = textUpdate(req.body, "reason", 2000);
  if (!quote || !reason) return res.status(400).json({ success: false, error: "An exact quote and reason are required" });
  try {
    const { data: entry, error: entryError } = await supabase.from("timeline_entries").select("*")
      .eq("id", req.params.entryId).eq("user_id", req.user.id).eq("status", "active").maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Active timeline entry not found" });
    if (!entry.body_markdown.includes(quote) && !entry.current_state.includes(quote)) {
      return res.status(400).json({ success: false, error: "The quote must appear exactly in the journal text or current state" });
    }
    let replacementEntryId = null;
    if (req.body.replacementEntryId) {
      const { data: replacement, error: replacementError } = await supabase.from("timeline_entries").select("id")
        .eq("id", req.body.replacementEntryId).eq("user_id", req.user.id)
        .eq("character_id", entry.character_id).eq("status", "active").maybeSingle();
      if (replacementError) throw replacementError;
      if (!replacement) return res.status(400).json({ success: false, error: "Replacement entry must be an active journal for the same companion" });
      replacementEntryId = replacement.id;
    }
    const { data: retraction, error: retractionError } = await supabase.from("timeline_retractions").insert({
      user_id: req.user.id,
      character_id: entry.character_id,
      timeline_entry_id: entry.id,
      replacement_entry_id: replacementEntryId,
      quote,
      reason,
    }).select().single();
    if (retractionError) throw retractionError;
    const { data: updated, error: updateError } = await supabase.from("timeline_entries").update({
      status: "retracted", updated_at: new Date().toISOString(),
    }).eq("id", entry.id).eq("user_id", req.user.id).select().single();
    if (updateError) {
      await supabase.from("timeline_retractions").delete().eq("id", retraction.id).eq("user_id", req.user.id);
      throw updateError;
    }
    res.json({ success: true, entry: updated, retraction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/timeline/:entryId", async (req, res) => {
  const { data, error } = await supabase.from("timeline_entries").update({
    status: "deleted", updated_at: new Date().toISOString(),
  }).eq("id", req.params.entryId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Timeline entry not found" });
  res.status(204).end();
});

app.get("/handoffs", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("session_handoffs").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, handoffs: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/handoffs/generate", async (req, res) => {
  try {
    const sourceSessionId = typeof req.body.sourceSessionId === "string" ? req.body.sourceSessionId : "";
    if (!sourceSessionId) return res.status(400).json({ success: false, error: "A source session is required" });
    await requireOwnedSession(sourceSessionId, req.user.id);
    const settings = await getSettings(req.user.id);
    const [{ data: messages, error: messagesError }, { data: memory, error: memoryError }] = await Promise.all([
      supabase.from("messages").select("id,role,content,created_at")
        .eq("session_id", sourceSessionId).eq("is_visible", true).eq("context_status", "active")
        .order("created_at", { ascending: false }).limit(40),
      supabase.from("session_memories").select("summary").eq("session_id", sourceSessionId).maybeSingle(),
    ]);
    if (messagesError) throw messagesError;
    if (memoryError) throw memoryError;
    const chronological = [...(messages || [])].reverse();
    if (!chronological.length) return res.status(400).json({ success: false, error: "This conversation has no messages to hand off" });
    const raw = await callModel({
      purpose: "conversation_summary",
      model: settings.summary_model,
      temperature: 0.1,
      maxTokens: 1200,
      thinking: "disabled",
      responseFormat: "json_object",
      userId: req.user.id,
      messages: [
        { role: "system", content: "You create careful, factual conversation handoffs. Return the requested JSON object only." },
        { role: "user", content: buildHandoffPrompt({ summary: memory?.summary, messages: chronological }) },
      ],
    });
    const candidate = parseHandoffCandidate(raw);
    res.json({
      success: true,
      candidate: {
        ...candidate,
        sourceSessionId,
        tailMessageIds: chronological.slice(-8).map((item) => item.id),
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/handoffs", async (req, res) => {
  try {
    const sourceSessionId = typeof req.body.sourceSessionId === "string" ? req.body.sourceSessionId : "";
    if (!sourceSessionId) return res.status(400).json({ success: false, error: "A source session is required" });
    const session = await requireOwnedSession(sourceSessionId, req.user.id);
    const character = session.character_id
      ? await getOwnedCharacter(session.character_id, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const bodyMarkdown = textUpdate(req.body, "bodyMarkdown", 12000);
    const currentState = textUpdate(req.body, "currentState", 3000);
    if (!bodyMarkdown || !currentState) return res.status(400).json({ success: false, error: "Handoff text and current state are required" });
    let tailMessageIds = await ownedMessageIds(req.body.tailMessageIds, sourceSessionId, 12);
    if (!tailMessageIds.length) {
      const { data: tail, error: tailError } = await supabase.from("messages").select("id")
        .eq("session_id", sourceSessionId).eq("is_visible", true).eq("context_status", "active")
        .order("created_at", { ascending: false }).limit(8);
      if (tailError) throw tailError;
      tailMessageIds = (tail || []).reverse().map((item) => item.id);
    }
    const { data, error } = await supabase.from("session_handoffs").insert({
      user_id: req.user.id,
      character_id: character.id,
      source_session_id: sourceSessionId,
      body_markdown: bodyMarkdown,
      current_state: currentState,
      topics: limitedStrings(req.body.topics, 20, 160),
      open_loops: limitedStrings(req.body.openLoops, 20, 300),
      continuation_guidance: textUpdate(req.body, "continuationGuidance", 3000) || "",
      tail_message_ids: tailMessageIds,
      status: req.body.status === "confirmed" ? "confirmed" : "auto",
    }).select().single();
    if (error) throw error;
    await supabase.from("session_handoffs").update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .neq("id", data.id).in("status", ["auto", "confirmed"]);
    res.status(201).json({ success: true, handoff: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/handoffs/:handoffId", async (req, res) => {
  const updates = {};
  for (const [bodyKey, column, max] of [
    ["bodyMarkdown", "body_markdown", 12000], ["currentState", "current_state", 3000],
    ["continuationGuidance", "continuation_guidance", 3000],
  ]) {
    const value = textUpdate(req.body, bodyKey, max);
    if (value !== undefined) updates[column] = value;
  }
  if (Array.isArray(req.body.topics)) updates.topics = limitedStrings(req.body.topics, 20, 160);
  if (Array.isArray(req.body.openLoops)) updates.open_loops = limitedStrings(req.body.openLoops, 20, 300);
  if (["auto", "confirmed", "superseded"].includes(req.body.status)) updates.status = req.body.status;
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No handoff fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("session_handoffs").update(updates)
    .eq("id", req.params.handoffId).eq("user_id", req.user.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Handoff not found" });
  res.json({ success: true, handoff: data });
});

app.get("/memories", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("memories").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .neq("status", "deleted").order("updated_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, memories: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/memories", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const category = String(req.body.category || "important_event");
    const content = textUpdate(req.body, "content", 1200);
    const triggers = splitTriggers(req.body.triggers, 6).map((item) => item.slice(0, 80));
    if (!content || !MEMORY_CATEGORIES.has(category) || !triggers.length) {
      return res.status(400).json({ success: false, error: "Valid category, content, and triggers are required" });
    }
    const { data, error } = await supabase.from("memories").insert({
      user_id: req.user.id, character_id: character.id, category, content, triggers,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, memory: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/memories/:memoryId", async (req, res) => {
  const updates = {};
  const content = textUpdate(req.body, "content", 1200);
  if (content !== undefined) updates.content = content;
  if (MEMORY_CATEGORIES.has(req.body.category)) updates.category = req.body.category;
  if (["active", "archived"].includes(req.body.status)) updates.status = req.body.status;
  if (typeof req.body.isPermanent === "boolean") updates.is_permanent = req.body.isPermanent;
  if (Array.isArray(req.body.triggers) || typeof req.body.triggers === "string") {
    updates.triggers = splitTriggers(req.body.triggers, 6).map((item) => item.slice(0, 80));
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No memory fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("memories").update(updates)
    .eq("id", req.params.memoryId).eq("user_id", req.user.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Memory not found" });
  res.json({ success: true, memory: data });
});

app.delete("/memories/:memoryId", async (req, res) => {
  const { data, error } = await supabase.from("memories").update({
    status: "deleted", updated_at: new Date().toISOString(),
  }).eq("id", req.params.memoryId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Memory not found" });
  res.status(204).end();
});

app.get("/follow-ups", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("follow_ups").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .neq("status", "cancelled").order("updated_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, followUps: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/follow-ups", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const title = textUpdate(req.body, "title", 120);
    const content = textUpdate(req.body, "content", 1200);
    const nextStep = textUpdate(req.body, "nextStep", 600) || "";
    const kind = FOLLOW_UP_KINDS.has(req.body.kind) ? req.body.kind : "plan";
    const triggers = splitTriggers(req.body.triggers, 6).map((item) => item.slice(0, 80));
    const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
    if (!title || !content || !triggers.length || (dueAt && Number.isNaN(dueAt.getTime()))) {
      return res.status(400).json({ success: false, error: "Valid title, content, triggers, and optional date are required" });
    }
    const { data, error } = await supabase.from("follow_ups").insert({
      user_id: req.user.id,
      character_id: character.id,
      title,
      kind,
      content,
      next_step: nextStep,
      triggers,
      due_at: dueAt ? dueAt.toISOString() : null,
      allow_proactive: req.body.allowProactive === true,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, followUp: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/follow-ups/:followUpId", async (req, res) => {
  const updates = {};
  for (const [bodyKey, column, max] of [
    ["title", "title", 120], ["content", "content", 1200], ["nextStep", "next_step", 600],
  ]) {
    const value = textUpdate(req.body, bodyKey, max);
    if (value !== undefined) updates[column] = value;
  }
  if (updates.title === "" || updates.content === "") {
    return res.status(400).json({ success: false, error: "Title and content cannot be empty" });
  }
  if (FOLLOW_UP_KINDS.has(req.body.kind)) updates.kind = req.body.kind;
  if (FOLLOW_UP_STATUSES.has(req.body.status)) updates.status = req.body.status;
  if (typeof req.body.allowProactive === "boolean") updates.allow_proactive = req.body.allowProactive;
  if (Array.isArray(req.body.triggers) || typeof req.body.triggers === "string") {
    updates.triggers = splitTriggers(req.body.triggers, 6).map((item) => item.slice(0, 80));
  }
  if (req.body.dueAt === null || req.body.dueAt === "") updates.due_at = null;
  else if (req.body.dueAt !== undefined) {
    const dueAt = new Date(req.body.dueAt);
    if (Number.isNaN(dueAt.getTime())) return res.status(400).json({ success: false, error: "Invalid date" });
    updates.due_at = dueAt.toISOString();
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No follow-up fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("follow_ups").update(updates)
    .eq("id", req.params.followUpId).eq("user_id", req.user.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Follow-up not found" });
  res.json({ success: true, followUp: data });
});

app.post("/follow-ups/confirm-create", async (req, res) => {
  try {
    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : "";
    if (!sessionId) return res.status(400).json({ success: false, error: "A session is required" });
    const session = await requireOwnedSession(sessionId, req.user.id);
    const character = session.character_id
      ? await getOwnedCharacter(session.character_id, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const title = textUpdate(req.body, "title", 120);
    const content = textUpdate(req.body, "content", 1200);
    const status = ["active", "waiting", "completed", "paused"].includes(req.body.status) ? req.body.status : null;
    const kind = FOLLOW_UP_KINDS.has(req.body.kind) ? req.body.kind : "paused_topic";
    const triggers = splitTriggers(req.body.triggers, 6).map((item) => item.slice(0, 80));
    const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
    const { data: duplicate, error: duplicateError } = await supabase.from("follow_ups").select("id")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .ilike("title", title || "").neq("status", "cancelled").limit(1).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) return res.status(409).json({ success: false, error: "A topic with this title already exists" });
    if (!title || !content || !status || !triggers.length || (dueAt && Number.isNaN(dueAt.getTime()))) {
      return res.status(400).json({ success: false, error: "Invalid semantic event" });
    }
    const { data: followUp, error: createError } = await supabase.from("follow_ups").insert({
      user_id: req.user.id, character_id: character.id, title, kind, content, status, triggers,
      due_at: dueAt ? dueAt.toISOString() : null, source_session_id: sessionId, allow_proactive: false,
    }).select().single();
    if (createError) throw createError;
    return res.status(201).json({ success: true, followUp });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});
app.post("/follow-ups/:followUpId/confirm-status", async (req, res) => {
  const nextStatus = req.body.status;
  const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
  if (!["active", "waiting", "completed", "paused"].includes(nextStatus)
      || (dueAt && Number.isNaN(dueAt.getTime()))) {
    return res.status(400).json({ success: false, error: "Invalid follow-up status" });
  }
  try {
    const { data: followUp, error: followUpError } = await supabase.from("follow_ups").select("*")
      .eq("id", req.params.followUpId).eq("user_id", req.user.id).maybeSingle();
    if (followUpError) throw followUpError;
    if (!followUp) return res.status(404).json({ success: false, error: "Follow-up not found" });

    const sessionId = req.body.sessionId || null;
    if (sessionId) {
      const session = await requireOwnedSession(sessionId, req.user.id);
      if (session.character_id !== followUp.character_id) {
        return res.status(400).json({ success: false, error: "Session and follow-up use different companions" });
      }
    }
    if (followUp.status === nextStatus && !dueAt) {
      return res.json({ success: true, followUp, unchanged: true });
    }

    const updates = { status: nextStatus, updated_at: new Date().toISOString() };
    if (dueAt) updates.due_at = dueAt.toISOString();
    const { data: updated, error: updateError } = await supabase.from("follow_ups").update(updates)
      .eq("id", followUp.id).eq("user_id", req.user.id).select().single();
    if (updateError) throw updateError;
    res.json({ success: true, followUp: updated, unchanged: false });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});
app.delete("/follow-ups/:followUpId", async (req, res) => {
  const { data, error } = await supabase.from("follow_ups").delete()
    .eq("id", req.params.followUpId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Follow-up not found" });
  res.status(204).end();
});

// Session management
app.get("/sessions", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, name, character_id, created_at, updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json(data);
});

app.post("/sessions", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 48) : "";

  try {
    const session = await createSession(req.user.id, name || DEFAULT_SESSION_NAME, req.body.characterId);
    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/sessions/:sessionId", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 48) : "";
  if (!name) return res.status(400).json({ success: false, error: "A session name is required" });

  const { data, error } = await supabase
    .from("sessions")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", req.params.sessionId)
    .eq("user_id", req.user.id)
    .select("id, name, character_id, created_at, updated_at")
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Session not found" });
  res.json({ success: true, session: data });
});

app.delete("/sessions/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;

  try { await requireOwnedSession(sessionId, req.user.id); } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }

  const { error: messagesError } = await supabase
    .from("messages")
    .delete()
    .eq("session_id", sessionId);
  if (messagesError) return res.status(500).json({ success: false, error: messagesError.message });

  const { error: memoriesError } = await supabase
    .from("session_memories")
    .delete()
    .eq("session_id", sessionId);
  if (memoriesError) return res.status(500).json({ success: false, error: memoriesError.message });

  const { error: sessionError } = await supabase
    .from("sessions")
    .delete()
    .eq("id", sessionId);
  if (sessionError) return res.status(500).json({ success: false, error: sessionError.message });

  res.status(204).end();
});

// Message reads and writes. The legacy /messages/:sessionId route remains supported.
async function readVisibleMessages(sessionId, userId) {
  await requireOwnedSession(sessionId, userId);
  const { data, error } = await supabase
    .from("messages")
    .select("id, session_id, role, content, is_visible, context_status, replaces_message_id, generation_status, finish_reason, continues_message_id, created_at")
    .eq("session_id", sessionId)
    .eq("is_visible", true)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data;
}

async function sendMessages(req, res) {
  try {
    const messages = await readVisibleMessages(req.params.sessionId, req.user.id);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

app.get("/sessions/:sessionId/messages", sendMessages);
app.get("/messages/:sessionId", sendMessages);

app.get("/source-messages", async (req, res) => {
  try {
    const sessionId = validUuid(req.query.sessionId) ? req.query.sessionId : null;
    const importId = validUuid(req.query.importId) ? req.query.importId : null;
    if (!sessionId && !importId) return res.status(400).json({ success: false, error: "A valid sessionId or importId is required" });
    let query = supabase.from("source_messages").select("id,character_id,source_kind,revision_kind,role,raw_content,occurred_at,session_id,import_id,imported_segment_id,operational_message_id,supersedes_source_message_id,revision_number,source_position,segment_message_index,source_metadata,created_at")
      .eq("user_id", req.user.id).order("occurred_at").order("created_at").limit(1000);
    query = sessionId ? query.eq("session_id", sessionId) : query.eq("import_id", importId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, messages: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

async function readAllOwnedSourceMessages(userId, characterId) {
  const messages = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("source_messages")
      .select("id,source_kind,revision_kind,role,raw_content,occurred_at,operational_message_id,revision_number,source_metadata")
      .eq("user_id", userId).eq("character_id", characterId)
      .order("occurred_at").order("created_at").range(from, from + pageSize - 1);
    if (error) throw error;
    messages.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return messages;
}

async function latestSharedDayVersions(dayIds, userId) {
  if (!dayIds.length) return new Map();
  const { data, error } = await supabase.from("shared_life_day_versions").select("*")
    .eq("user_id", userId).in("shared_day_id", dayIds)
    .order("revision_number", { ascending: false });
  if (error) throw error;
  const latest = new Map();
  for (const version of data || []) if (!latest.has(version.shared_day_id)) latest.set(version.shared_day_id, version);
  return latest;
}

async function sourceIndexCorpus(userId, characterId) {
  const sourceMessages = await readAllOwnedSourceMessages(userId, characterId);
  const sourceById = new Map(sourceMessages.map((message)=>[message.id,message]));
  const groups = groupSourceMessagesBySharedDay(sourceMessages);
  const { data: days, error: dayError } = await supabase.from("shared_life_days").select("id,day_key")
    .eq("user_id",userId).eq("character_id",characterId);
  if (dayError) throw dayError;
  const dayByKey = new Map((days||[]).map((day)=>[day.day_key,day]));
  const rows=[];
  for(const group of groups){
    const day=dayByKey.get(group.dayKey); if(!day)continue;
    for(const sourceId of group.sourceMessageIds){const message=sourceById.get(sourceId);if(message)rows.push({message,sharedDayId:day.id});}
  }
  return rows;
}

async function readIndexRows(table, columns, orderColumn, userId, characterId, filters = {}) {
  const rows = []; const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).eq("user_id", userId).eq("character_id", characterId)
      .order(orderColumn).range(from, from + pageSize - 1);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query; if (error) throw error;
    rows.push(...(data || [])); if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function sourceRetrievalWindows(userId, characterId) {
  return buildRetrievalWindows(await sourceIndexCorpus(userId, characterId)).map((window) => ({
    ...window, windowKey: crypto.createHash("sha256").update(window.sourceMessageIds.join(":"), "utf8").digest("hex"),
  }));
}

async function sourceIndexStatus(userId,characterId) {
  const target=await getEmbeddingTarget(userId).catch(()=>null);
  const lexicalQuery=supabase.from("source_retrieval_windows").select("id",{count:"exact",head:true})
    .eq("user_id",userId).eq("character_id",characterId).eq("algorithm_version","raw-turn-window-v1");
  const embeddingQuery=target
    ? supabase.from("source_retrieval_window_embeddings").select("id",{count:"exact",head:true})
      .eq("user_id",userId).eq("character_id",characterId).eq("model_id",target.model)
    : Promise.resolve({count:0,error:null});
  const [lexical,embedding]=await Promise.all([lexicalQuery,embeddingQuery]);
  if(lexical.error||embedding.error)throw lexical.error||embedding.error;
  const lexicalCount=Number(lexical.count||0); const embeddingCount=Number(embedding.count||0);
  return {sourceCount:lexicalCount,windowCount:lexicalCount,lexicalCount,embeddingCount,embeddingConfigured:Boolean(target),embeddingModel:target?.model||null,indexVersion:"raw-turn-window-v1"};
}

async function buildSourceIndexBatch(userId,characterId,{includeEmbeddings=true,embeddingLimit=96}={}) {
  const windows=await sourceRetrievalWindows(userId,characterId); if(!windows.length)return sourceIndexStatus(userId,characterId);
  const existingWindows=await readIndexRows("source_retrieval_windows","id,window_key","id",userId,characterId,{algorithm_version:"raw-turn-window-v1"});
  const existingKeys=new Set(existingWindows.map((item)=>item.window_key));
  const lexicalRows=windows.filter((window)=>!existingKeys.has(window.windowKey)).map((window)=>({
    user_id:userId,character_id:characterId,shared_day_id:window.sharedDayId,window_key:window.windowKey,
    source_message_ids:window.sourceMessageIds,lexical_terms:window.lexicalTerms.length?window.lexicalTerms:["__empty__"],
    algorithm_version:"raw-turn-window-v1",occurred_at:window.occurredAt,
  }));
  for(let index=0;index<lexicalRows.length;index+=500){const {error}=await supabase.from("source_retrieval_windows").upsert(lexicalRows.slice(index,index+500),{onConflict:"user_id,character_id,window_key,algorithm_version",ignoreDuplicates:true});if(error)throw error;}
  const target=includeEmbeddings?await getEmbeddingTarget(userId):null;
  if(target){
    const storedWindows=await readIndexRows("source_retrieval_windows","id,window_key","id",userId,characterId,{algorithm_version:"raw-turn-window-v1"});
    const idByKey=new Map(storedWindows.map((item)=>[item.window_key,item.id]));
    const existingEmbeddings=await readIndexRows("source_retrieval_window_embeddings","window_id","window_id",userId,characterId,{model_id:target.model});
    const embeddedIds=new Set(existingEmbeddings.map((item)=>item.window_id));
    const missing=windows.filter((window)=>idByKey.has(window.windowKey)&&!embeddedIds.has(idByKey.get(window.windowKey))).slice(0,Math.max(1,Math.min(embeddingLimit,192)));
    for(let index=0;index<missing.length;index+=32){
      const batch=missing.slice(index,index+32); const vectors=await callEmbeddings({userId,target,inputs:batch.map((window)=>window.rawText.slice(0,12000))});
      const rows=batch.map((window,offset)=>({user_id:userId,character_id:characterId,window_id:idByKey.get(window.windowKey),model_id:target.model,embedding:JSON.stringify(vectors[offset]),dimensions:vectors[offset].length}));
      const {error}=await supabase.from("source_retrieval_window_embeddings").upsert(rows,{onConflict:"window_id,model_id",ignoreDuplicates:true}); if(error)throw error;
    }
  }
  return sourceIndexStatus(userId,characterId);
}

async function continueSourceIndexIfStarted(userId,characterId) {
  const status=await sourceIndexStatus(userId,characterId);
  if(status.lexicalCount>0)await buildSourceIndexBatch(userId,characterId,{includeEmbeddings:status.embeddingConfigured,embeddingLimit:192});
}

async function loadConfirmedDiaryForDay(userId,characterId,sharedDayId) {
  const {data,error}=await supabase.from("diary_entries").select("*").eq("user_id",userId).eq("character_id",characterId).eq("shared_day_id",sharedDayId)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw error; return data?.status==="confirmed"?data:null;
}

async function querySourceRecallCandidates({userId,characterId,message,allowSemantic=true}) {
  const terms=retrievalQueryTerms(message); if(!terms.length)return {terms,lexicalMatches:[],semanticMatches:[],ranked:[],embeddingModel:null};
  const lexicalResult=await supabase.rpc("match_source_window_lexical",{p_user_id:userId,p_character_id:characterId,p_terms:terms,p_limit:80});
  if(lexicalResult.error)throw lexicalResult.error;
  const lexicalMatches=(lexicalResult.data||[]).filter((match)=>lexicalCandidateAccepted(match,terms));
  const admittedDays=new Set(lexicalMatches.map((match)=>match.shared_day_id));
  let semanticMatches=[]; let target=null;
  if(allowSemantic){
    try{target=await getEmbeddingTarget(userId);if(target){const [vector]=await callEmbeddings({userId,target,inputs:[message]});const semanticResult=await supabase.rpc("match_source_window_semantic",{p_user_id:userId,p_character_id:characterId,p_model_id:target.model,p_query_embedding:JSON.stringify(vector),p_limit:80});if(semanticResult.error)throw semanticResult.error;semanticMatches=semanticResult.data||[];}}
    catch(error){console.error("Semantic source recall failed; lexical recall remains available:",error.message);}
  }
  return {
    terms,lexicalMatches,semanticMatches,embeddingModel:target?.model||null,
    ranked:rankSharedDays({lexicalMatches,semanticMatches:semanticMatches.filter((item)=>admittedDays.has(item.shared_day_id))}),
  };
}

async function recallSharedDay({userId,characterId,sessionId,message,allowSemantic=true,writePointer=true}) {
  const {terms,ranked}=await querySourceRecallCandidates({userId,characterId,message,allowSemantic}); if(!terms.length)return "";
  let selected=ranked[0]||null; let diary=selected?await loadConfirmedDiaryForDay(userId,characterId,selected.sharedDayId):null;
  let pointer=null;
  if(!selected&&sessionId){const {data}=await supabase.from("memory_recall_pointers").select("*").eq("session_id",sessionId).eq("user_id",userId).eq("active",true).maybeSingle();pointer=data||null;if(pointer&&shouldContinueRecallPointer(message)){selected={sharedDayId:pointer.shared_day_id,anchorSourceMessageIds:pointer.anchor_source_message_ids,score:1};diary=await loadConfirmedDiaryForDay(userId,characterId,pointer.shared_day_id);}else if(pointer&&writePointer){await supabase.from("memory_recall_pointers").update({active:false,updated_at:new Date().toISOString()}).eq("session_id",sessionId).eq("user_id",userId);}}
  if(!selected)return "本轮自动回忆检索没有找到带有真实字面证据的旧事。不要拿仅有语义相似但尚未标定的候选猜测，也不要假装已经想起来。";
  const [{data:day,error:dayError},{data:version,error:versionError},{data:annotations,error:annotationError}]=await Promise.all([
    supabase.from("shared_life_days").select("day_key").eq("id",selected.sharedDayId).eq("user_id",userId).single(),
    supabase.from("shared_life_day_versions").select("source_message_ids").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).order("revision_number",{ascending:false}).limit(1).single(),
    diary?supabase.from("diary_review_events").select("*").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).in("event_kind",["factual_note_added","relationship_note_added"]).order("created_at",{ascending:true}):Promise.resolve({data:[],error:null}),
  ]);
  if(dayError||versionError||annotationError)throw dayError||versionError||annotationError;
  const byId=new Map((await readAllOwnedSourceMessages(userId,characterId)).map((source)=>[source.id,source]));
  const messages=(version.source_message_ids||[]).map((id)=>byId.get(id)).filter(Boolean).map((source)=>({id:source.id,role:source.role,content:source.raw_content,occurredAt:source.source_metadata?.original_message_created_at||source.occurred_at}));
  const excerpt=selectSourceExcerpt(messages,selected.anchorSourceMessageIds,12000);
  if(writePointer&&sessionId){await supabase.from("memory_recall_pointers").upsert({session_id:sessionId,user_id:userId,character_id:characterId,shared_day_id:selected.sharedDayId,anchor_source_message_ids:selected.anchorSourceMessageIds,pointer_label:`刚才正在谈 ${day.day_key} 的共同生活`,query_terms:terms,active:true,recalled_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:"session_id"});}
  return formatSharedDayRecall({dayKey:day.day_key,diary,annotations:annotations||[],messages:excerpt.messages,partial:excerpt.partial});
}

app.get("/diary/shared-days", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data: days, error } = await supabase.from("shared_life_days").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("day_key", { ascending: false }).limit(120);
    if (error) throw error;
    const versions = await latestSharedDayVersions((days || []).map((day) => day.id), req.user.id);
    res.json({ success: true, days: (days || []).map((day) => ({ ...day, latestVersion: versions.get(day.id) || null })) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

async function rebuildSharedLifeDays(userId,characterId) {
    const grouped = groupSourceMessagesBySharedDay(await readAllOwnedSourceMessages(userId,characterId));
    let appendedVersions = 0;
    for (const group of grouped) {
      let { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
        .eq("user_id",userId).eq("character_id",characterId).eq("day_key", group.dayKey).maybeSingle();
      if (dayError) throw dayError;
      if (!day) {
        const inserted = await supabase.from("shared_life_days").insert({
          user_id:userId,character_id:characterId,day_key:group.dayKey,
        }).select().single();
        if (inserted.error) throw inserted.error;
        day = inserted.data;
      }
      const { data: previous, error: previousError } = await supabase.from("shared_life_day_versions").select("*")
        .eq("shared_day_id", day.id).eq("user_id",userId)
        .order("revision_number", { ascending: false }).limit(1).maybeSingle();
      if (previousError) throw previousError;
      const sameSources = previous
        && JSON.stringify(previous.source_message_ids) === JSON.stringify(group.sourceMessageIds);
      const unchanged = sameSources
        && (previous.boundary_reason === "manual_end" || (
          previous.boundary_state === group.boundaryState
        && previous.boundary_reason === group.boundaryReason
        && previous.morning_marker_source_id === group.morningMarkerSourceId
        && previous.night_marker_source_id === group.nightMarkerSourceId));
      if (unchanged) continue;
      const { error: versionError } = await supabase.from("shared_life_day_versions").insert({
        shared_day_id:day.id,user_id:userId,character_id:characterId,
        revision_number: previous ? previous.revision_number + 1 : 0,
        started_at: group.startedAt, ended_at: group.endedAt,
        source_message_ids: group.sourceMessageIds,
        first_source_message_id: group.firstSourceMessageId,
        last_source_message_id: group.lastSourceMessageId,
        morning_marker_source_id: group.morningMarkerSourceId,
        night_marker_source_id: group.nightMarkerSourceId,
        boundary_state: group.boundaryState, boundary_reason: group.boundaryReason,
        supersedes_version_id: previous?.id || null,
      });
      if (versionError) throw versionError;
      appendedVersions += 1;
    }
    return {discoveredDays:grouped.length,appendedVersions};
}

app.post("/diary/shared-days/rebuild", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    res.json({success:true,...await rebuildSharedLifeDays(req.user.id,character.id)});
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/diary/shared-days/:sharedDayId/seal", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
      .eq("id", req.params.sharedDayId).eq("user_id", req.user.id).eq("character_id", character.id).maybeSingle();
    if (dayError) throw dayError;
    if (!day) return res.status(404).json({ success: false, error: "Shared life day not found" });
    const { data: previous, error: previousError } = await supabase.from("shared_life_day_versions").select("*")
      .eq("shared_day_id", day.id).eq("user_id", req.user.id)
      .order("revision_number", { ascending: false }).limit(1).maybeSingle();
    if (previousError) throw previousError;
    if (!previous) return res.status(409).json({ success: false, error: "This shared day has no source messages" });
    if (previous.boundary_state === "sealed") return res.json({ success: true, created: false, version: previous });
    const { data: version, error: insertError } = await supabase.from("shared_life_day_versions").insert({
      shared_day_id: day.id, user_id: req.user.id, character_id: character.id,
      revision_number: previous.revision_number + 1,
      started_at: previous.started_at, ended_at: previous.ended_at,
      source_message_ids: previous.source_message_ids,
      first_source_message_id: previous.first_source_message_id,
      last_source_message_id: previous.last_source_message_id,
      morning_marker_source_id: previous.morning_marker_source_id,
      night_marker_source_id: previous.night_marker_source_id,
      boundary_state: "sealed", boundary_reason: "manual_end", supersedes_version_id: previous.id,
    }).select().single();
    if (insertError) throw insertError;
    res.status(201).json({ success: true, created: true, version });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

async function processDiaryGenerationJob(jobId) {
  const { data: job, error: jobError } = await supabase.from("diary_generation_jobs").select("*")
    .eq("id", jobId).maybeSingle();
  if (jobError) throw jobError;
  if (!job || job.status !== "queued") return;
  const startedAt = new Date().toISOString();
  const { error: runningError } = await supabase.from("diary_generation_jobs").update({
    status: "running", started_at: startedAt, updated_at: startedAt, error_code: null, failure_stage: null,
  }).eq("id", job.id).eq("status", "queued");
  if (runningError) throw runningError;
  let failureStage = "source_read";
  try {
    const [{ data: day, error: dayError }, { data: version, error: versionError }] = await Promise.all([
      supabase.from("shared_life_days").select("*").eq("id", job.shared_day_id).eq("user_id", job.user_id).maybeSingle(),
      supabase.from("shared_life_day_versions").select("*").eq("id", job.shared_day_version_id).eq("user_id", job.user_id).maybeSingle(),
    ]);
    if (dayError || versionError) throw dayError || versionError;
    if (!day || !version || version.boundary_state !== "sealed") throw new Error("Only a sealed shared day can become a diary");
    const sourceById = new Map((await readAllOwnedSourceMessages(job.user_id, job.character_id)).map((message) => [message.id, message]));
    const sourceMessages = version.source_message_ids.map((id) => sourceById.get(id)).filter(Boolean).map((message) => ({
      ...message,
      effective_occurred_at: message.source_metadata?.original_message_created_at || message.occurred_at,
    }));
    if (sourceMessages.length !== version.source_message_ids.length) throw new Error("A diary source message is missing");
    const settings = await getSettings(job.user_id);
    const target = await getModelTarget({ userId:job.user_id, purpose:"diary_generation", legacyModel:settings.summary_model });
    await supabase.from("diary_generation_jobs").update({
      requested_model:target.model, source_message_count:sourceMessages.length, updated_at:new Date().toISOString(),
    }).eq("id",job.id);
    failureStage = "model_request";
    const raw = await callModel({
      purpose: "diary_generation", model: settings.summary_model, userId: job.user_id,
      sessionId: job.shared_day_id, temperature: 0.2, maxTokens: 7000, responseFormat: "json_object", thinking: "disabled",
      messages: [
        { role: "system", content: "你只根据给定原始消息写有证据的第一人称中文日记，并严格返回指定 JSON。" },
        { role: "user", content: buildGroundedDiaryPrompt({ dayKey: day.day_key, messages: sourceMessages }) },
      ],
    });
    failureStage = "model_parse";
    const diary = parseGroundedDiary(raw, sourceMessages);
    failureStage = "validation";
    const validation = validateGroundedDiary(diary, sourceMessages, { dayKey: day.day_key });
    const importedDraft = sourceMessages.some((message) => message.source_kind === "claude_import");
    if (importedDraft && !validation.issues.some((issue) => issue.kind === "imported_draft")) {
      validation.issues.push({
        kind: "imported_draft", itemIndex: null, text: "",
        reasons: ["旧记录生成的日记默认保持草稿；只有妤妤主动确认后才进入未来检索。"],
      });
    }
    const status = validation.issues.length ? "needs_review" : "confirmed";
    const entryId = crypto.randomUUID();
    failureStage = "storage";
    const { error: saveError } = await supabase.rpc("save_grounded_diary", {
      p_entry_id: entryId, p_user_id: job.user_id, p_character_id: job.character_id,
      p_shared_day_id: day.id, p_shared_day_version_id: version.id, p_generation_job_id: job.id,
      p_status: status, p_title: diary.title, p_body_markdown: diary.bodyMarkdown,
      p_current_state: diary.currentState, p_source_message_ids: version.source_message_ids,
      p_validation_issues: validation.issues,
      p_facts: status === "confirmed"
        ? validation.validFacts.map((item) => ({ text: item.text, source_message_ids: item.sourceMessageIds }))
        : [],
      p_feelings: validation.validFeelings.map((item) => ({ text: item.text, source_message_ids: item.sourceMessageIds })),
    });
    if (saveError) throw saveError;
    const completedAt = new Date().toISOString();
    const { error: completeError } = await supabase.from("diary_generation_jobs").update({
      status: status === "confirmed" ? "succeeded" : "needs_review",
      completed_at: completedAt, updated_at: completedAt, error_code: null,
    }).eq("id", job.id);
    if (completeError) throw completeError;
    void continueSourceIndexIfStarted(job.user_id,job.character_id).catch((error)=>console.error("Background source indexing deferred:",error.message));
  } catch (error) {
    const completedAt = new Date().toISOString();
    await supabase.from("diary_generation_jobs").update({
      status: "failed", completed_at: completedAt, updated_at: completedAt,
      error_code: classifyDiaryGenerationError(error, failureStage), failure_stage:failureStage,
    }).eq("id", job.id);
    console.error("Diary generation failed:", error);
  }
}

function startDiaryJob(jobId) {
  setImmediate(() => processDiaryGenerationJob(jobId).catch((error) => console.error("Diary job crashed:", error)));
}

function startDiaryJobsSequentially(jobIds) {
  setImmediate(async () => {
    for (const jobId of jobIds) await processDiaryGenerationJob(jobId);
  });
}

async function createDiaryJobForLatestVersion({ userId, characterId, sharedDayId, retry = false }) {
  const { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
    .eq("id", sharedDayId).eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  if (dayError) throw dayError;
  if (!day) { const error = new Error("Shared life day not found"); error.status = 404; throw error; }
  const { data: version, error: versionError } = await supabase.from("shared_life_day_versions").select("*")
    .eq("shared_day_id", day.id).eq("user_id", userId).order("revision_number", { ascending: false }).limit(1).maybeSingle();
  if (versionError) throw versionError;
  if (!version || version.boundary_state !== "sealed") { const error = new Error("This shared day has not ended yet"); error.status = 409; throw error; }
  const { data: existing, error: existingError } = await supabase.from("diary_generation_jobs").select("*")
    .eq("shared_day_version_id", version.id).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing && (!retry || ["queued", "running", "succeeded"].includes(existing.status))) {
    return { job: existing, created: false };
  }
  const { count, error: countError } = await supabase.from("diary_generation_jobs").select("id", { count: "exact", head: true })
    .eq("shared_day_version_id", version.id).eq("user_id", userId);
  if (countError) throw countError;
  const { data: job, error: insertError } = await supabase.from("diary_generation_jobs").insert({
    user_id: userId, character_id: characterId, shared_day_id: day.id, shared_day_version_id: version.id,
    attempt_number: Number(count || 0) + 1, source_message_count:(version.source_message_ids||[]).length,
  }).select().single();
  if (insertError) throw insertError;
  return { job, created: true };
}

async function refreshSharedDaysAfterMarker(userId,characterId) {
  await rebuildSharedLifeDays(userId,characterId);
  const {data:days,error:dayError}=await supabase.from("shared_life_days").select("*")
    .eq("user_id",userId).eq("character_id",characterId).order("day_key",{ascending:false}).limit(10);
  if(dayError)throw dayError;
  const versions=await latestSharedDayVersions((days||[]).map((day)=>day.id),userId);
  const [{data:entries,error:entryError},{data:jobs,error:jobError}]=await Promise.all([
    supabase.from("diary_entries").select("shared_day_id").eq("user_id",userId).eq("character_id",characterId),
    supabase.from("diary_generation_jobs").select("shared_day_id").eq("user_id",userId).eq("character_id",characterId),
  ]);
  if(entryError||jobError)throw entryError||jobError;
  const used=new Set([...(entries||[]).map((item)=>item.shared_day_id),...(jobs||[]).map((item)=>item.shared_day_id)]);
  const candidate=(days||[]).find((day)=>versions.get(day.id)?.boundary_state==="sealed"&&!used.has(day.id));
  if(!candidate)return;
  const result=await createDiaryJobForLatestVersion({userId,characterId,sharedDayId:candidate.id});
  if(result.created)startDiaryJob(result.job.id);
}

app.post("/diary/backfill-sample", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const requestedCount = Math.min(5, Math.max(3, Number(req.body.count) || 3));
    const { data: days, error: dayError } = await supabase.from("shared_life_days").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("day_key", { ascending: false }).limit(120);
    if (dayError) throw dayError;
    const versions = await latestSharedDayVersions((days || []).map((day) => day.id), req.user.id);
    const [{ data: entries, error: entryError }, { data: jobs, error: jobError }] = await Promise.all([
      supabase.from("diary_entries").select("shared_day_id").eq("user_id", req.user.id).eq("character_id", character.id),
      supabase.from("diary_generation_jobs").select("shared_day_id").eq("user_id", req.user.id).eq("character_id", character.id),
    ]);
    if (entryError || jobError) throw entryError || jobError;
    const used = new Set([...(entries || []).map((item) => item.shared_day_id), ...(jobs || []).map((item) => item.shared_day_id)]);
    const candidates = (days || []).map((day) => ({ day, version: versions.get(day.id) }))
      .filter(({ day, version }) => version?.boundary_state === "sealed" && !used.has(day.id));
    const chosen = [];
    const choose = (candidate) => { if (candidate && !chosen.some((item) => item.day.id === candidate.day.id)) chosen.push(candidate); };
    choose(candidates[0]);
    choose([...candidates].sort((left, right) => right.version.source_message_ids.length - left.version.source_message_ids.length)[0]);
    const bySize = [...candidates].sort((left, right) => left.version.source_message_ids.length - right.version.source_message_ids.length);
    choose(bySize[Math.floor(bySize.length / 2)]);
    choose(candidates.find(({ version }) => version.night_marker_source_id));
    choose(candidates.at(-1));
    for (const candidate of candidates) {
      if (chosen.length >= requestedCount) break;
      choose(candidate);
    }
    const selected = chosen.slice(0, requestedCount);
    const createdJobs = [];
    for (const { day } of selected) {
      const result = await createDiaryJobForLatestVersion({ userId: req.user.id, characterId: character.id, sharedDayId: day.id });
      if (result.created) createdJobs.push(result.job);
    }
    startDiaryJobsSequentially(createdJobs.map((job) => job.id));
    res.status(202).json({
      success: true,
      selectedDays: selected.map(({ day, version }) => ({ id: day.id, dayKey: day.day_key, messageCount: version.source_message_ids.length })),
      jobs: createdJobs,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/diary/shared-days/:sharedDayId/generate", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const result = await createDiaryJobForLatestVersion({
      userId: req.user.id, characterId: character.id, sharedDayId: req.params.sharedDayId,
      retry: req.body.retry === true,
    });
    if (result.created) startDiaryJob(result.job.id);
    res.status(result.created ? 202 : 200).json({ success: true, created: result.created, job: result.job });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/diary/entries", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_entries")
      .select("*,shared_life_days(day_key)").eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: false }).limit(120);
    if (error) throw error;
    res.json({ success: true, entries: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/diary/entries/:entryId/sources", async (req, res) => {
  try {
    const { data: entry, error: entryError } = await supabase.from("diary_entries")
      .select("id,character_id,source_message_ids").eq("id", req.params.entryId).eq("user_id", req.user.id).maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Diary entry not found" });
    const byId = new Map((await readAllOwnedSourceMessages(req.user.id, entry.character_id)).map((message) => [message.id, message]));
    const messages = entry.source_message_ids.map((id) => byId.get(id)).filter(Boolean).map((message) => ({
      id: message.id, role: message.role, content: message.raw_content,
      occurredAt: message.source_metadata?.original_message_created_at || message.occurred_at,
    }));
    res.json({ success: true, messages, partial: messages.length !== entry.source_message_ids.length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/diary/review-events", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_review_events").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: true }).limit(1000);
    if (error) throw error;
    res.json({ success: true, events: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/diary/entries/:entryId/review", async (req, res) => {
  try {
    const { data: entry, error: entryError } = await supabase.from("diary_entries").select("*")
      .eq("id", req.params.entryId).eq("user_id", req.user.id).maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Diary entry not found" });
    const { data: latest, error: latestError } = await supabase.from("diary_entries").select("id")
      .eq("shared_day_id", entry.shared_day_id).eq("user_id", req.user.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (latestError) throw latestError;
    if (latest?.id !== entry.id) return res.status(409).json({ success: false, error: "This diary has a newer version; refresh before reviewing" });

    const action = String(req.body.action || "");
    const issueIndex = Number.isInteger(req.body.issueIndex) ? req.body.issueIndex : null;
    const replacementText = cleanText(req.body.replacementText, 3000);
    const content = cleanText(req.body.content, 8000);
    const anchorKind = req.body.anchorKind === "sentence" ? "sentence" : "entry";
    const anchorText = anchorKind === "sentence" ? cleanText(req.body.anchorText, 2000) : "";
    if (anchorKind === "sentence" && (!anchorText || !entry.body_markdown.includes(anchorText))) {
      return res.status(400).json({ success: false, error: "Choose a sentence from this diary as the annotation anchor" });
    }
    if (["add_factual_note", "add_relationship_note"].includes(action) && !content) {
      return res.status(400).json({ success: false, error: "Please write the annotation first" });
    }

    let supersedesEventId = null;
    if (action === "revoke_entry") {
      const { data: wholeEvents, error: wholeError } = await supabase.from("diary_review_events")
        .select("id,event_kind,created_at").eq("user_id", req.user.id).eq("shared_day_id", entry.shared_day_id)
        .in("event_kind", ["entry_confirmed", "entry_confirmation_revoked"])
        .order("created_at", { ascending: false }).limit(1);
      if (wholeError) throw wholeError;
      if (!wholeEvents?.length || wholeEvents[0].event_kind !== "entry_confirmed") {
        return res.status(409).json({ success: false, error: "This diary has no active whole-entry confirmation to revoke" });
      }
      supersedesEventId = wholeEvents[0].id;
    }

    let restoredIssues = [];
    if (action === "revoke_entry" && entry.supersedes_entry_id) {
      const { data: beforeConfirmation, error: beforeConfirmationError } = await supabase.from("diary_entries")
        .select("validation_issues").eq("id", entry.supersedes_entry_id).eq("user_id", req.user.id).maybeSingle();
      if (beforeConfirmationError) throw beforeConfirmationError;
      restoredIssues = Array.isArray(beforeConfirmation?.validation_issues) ? beforeConfirmation.validation_issues : [];
    }
    const review = applyDiaryReview(entry, { action, issueIndex, replacementText, restoredIssues });
    const eventId = crypto.randomUUID();
    const resultEntryId = review.changesEntry ? crypto.randomUUID() : null;
    const sourceMessageIds = ["confirm_fact", "confirm_entry"].includes(action)
      ? entry.source_message_ids : [];
    const { data: result, error: saveError } = await supabase.rpc("append_diary_review", {
      p_event_id: eventId, p_user_id: req.user.id, p_entry_id: entry.id,
      p_event_kind: reviewEventForAction(action),
      p_scope: ["add_factual_note", "add_relationship_note"].includes(action) ? "annotation"
        : action === "confirm_entry" || action === "revoke_entry" ? "entry" : "fact",
      p_issue_index: issueIndex, p_anchor_kind: anchorKind, p_anchor_text: anchorText || null,
      p_content: content || null, p_replacement_text: replacementText || null,
      p_provenance: action === "add_relationship_note" ? "relationship_note" : "user_later_confirmation",
      p_source_message_ids: sourceMessageIds, p_supersedes_event_id: supersedesEventId,
      p_batch_id: null, p_result_entry_id: resultEntryId,
      p_result_status: review.changesEntry ? review.status : null,
      p_result_body_markdown: review.changesEntry ? review.bodyMarkdown : null,
      p_result_validation_issues: review.changesEntry ? review.validationIssues : null,
    });
    if (saveError) throw saveError;
    const response = { success: true, result };
    if (resultEntryId) {
      const { data: nextEntry, error: nextError } = await supabase.from("diary_entries").select("*,shared_life_days(day_key)")
        .eq("id", resultEntryId).eq("user_id", req.user.id).single();
      if (nextError) throw nextError;
      response.entry = nextEntry;
    }
    res.status(201).json(response);
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/diary/jobs", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_generation_jobs").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: false }).limit(120);
    if (error) throw error;
    res.json({ success: true, jobs: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/diary/jobs/:jobId", async (req, res) => {
  const { data, error } = await supabase.from("diary_generation_jobs").select("*")
    .eq("id", req.params.jobId).eq("user_id", req.user.id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Diary job not found" });
  res.json({ success: true, job: data });
});

app.get("/memory-index/status", async (req,res)=>{
  try{const character=req.query.characterId?await getOwnedCharacter(req.query.characterId,req.user.id):await getOrCreateDefaultCharacter(req.user.id);res.json({success:true,status:await sourceIndexStatus(req.user.id,character.id)});}
  catch(error){res.status(error.status||500).json({success:false,error:error.message});}
});

app.post("/memory-index/build", async (req,res)=>{
  try{
    const character=req.body.characterId?await getOwnedCharacter(req.body.characterId,req.user.id):await getOrCreateDefaultCharacter(req.user.id);
    const status=await buildSourceIndexBatch(req.user.id,character.id,{includeEmbeddings:req.body.includeEmbeddings!==false,embeddingLimit:Math.min(192,Math.max(1,Number(req.body.embeddingLimit)||96))});
    res.json({success:true,status});
  }catch(error){res.status(error.status||500).json({success:false,error:error.message});}
});

app.post("/memory-index/test", async (req,res)=>{
  try{
    const message=cleanText(req.body.message); if(!message)return res.status(400).json({success:false,error:"请输入要测试的回忆问法"});
    const character=req.body.characterId?await getOwnedCharacter(req.body.characterId,req.user.id):await getOrCreateDefaultCharacter(req.user.id);
    const result=await querySourceRecallCandidates({userId:req.user.id,characterId:character.id,message,allowSemantic:true});
    const dayIds=[...new Set([...result.lexicalMatches,...result.semanticMatches].map((item)=>item.shared_day_id))];
    const {data:days,error:dayError}=dayIds.length?await supabase.from("shared_life_days").select("id,day_key").eq("user_id",req.user.id).in("id",dayIds):{data:[],error:null};
    if(dayError)throw dayError; const dayById=new Map((days||[]).map((day)=>[day.id,day.day_key]));
    const {data:diaryStatuses,error:diaryStatusError}=dayIds.length?await supabase.from("diary_entries").select("shared_day_id,status,created_at").eq("user_id",req.user.id).eq("character_id",character.id).in("shared_day_id",dayIds).order("created_at",{ascending:false}):{data:[],error:null};
    if(diaryStatusError)throw diaryStatusError; const confirmed=new Map();
    for(const entry of diaryStatuses||[])if(!confirmed.has(entry.shared_day_id))confirmed.set(entry.shared_day_id,entry.status==="confirmed");
    const bestByDay=(items,valueKey)=>{const seen=new Set();return items.filter((item)=>{if(seen.has(item.shared_day_id))return false;seen.add(item.shared_day_id);return true;}).slice(0,5).map((item)=>({dayKey:dayById.get(item.shared_day_id)||"未知日期",score:Number(item[valueKey]||0),confirmed:Boolean(confirmed.get(item.shared_day_id))}));};
    const lexicalByDay=new Map();
    for(const item of result.lexicalMatches)if(!lexicalByDay.has(item.shared_day_id))lexicalByDay.set(item.shared_day_id,item);
    const semanticDays=new Set(result.semanticMatches.map((item)=>item.shared_day_id));
    const sourceById=new Map((await readAllOwnedSourceMessages(req.user.id,character.id)).map((source)=>[source.id,source]));
    const accepted=result.ranked.slice(0,5).map((item)=>{
      const lexical=lexicalByDay.get(item.sharedDayId); const sourceIds=lexical?.source_message_ids||item.anchorSourceMessageIds||[];
      const evidence=sourceIds.map((id)=>sourceById.get(id)).filter(Boolean).map((source)=>({
        id:source.id,role:source.role,content:source.raw_content,
        occurredAt:source.source_metadata?.original_message_created_at||source.occurred_at,
      }));
      const normalizedEvidence=evidence.map((message)=>String(message.content||"").normalize("NFKC").toLowerCase()).join("\n");
      const matchedTerms=result.terms.filter((term)=>normalizedEvidence.includes(String(term).normalize("NFKC").toLowerCase()));
      return {dayKey:dayById.get(item.sharedDayId)||"未知日期",score:item.score,confirmed:Boolean(confirmed.get(item.sharedDayId)),channels:semanticDays.has(item.sharedDayId)?["BM25","BGE-M3"]:["BM25"],matchedTerms,evidence};
    });
    res.json({success:true,test:{queryTerms:result.terms,embeddingModel:result.embeddingModel,lexical:bestByDay(result.lexicalMatches,"lexical_score"),semantic:bestByDay(result.semanticMatches,"similarity"),accepted,found:accepted.length>0}});
  }catch(error){res.status(error.status||500).json({success:false,error:error.message});}
});

app.post("/messages/:messageId/select-variant", async (req, res) => {
  try {
    const { data: selected, error: selectedError } = await supabase.from("messages")
      .select("id,session_id,role,created_at,replaces_message_id")
      .eq("id", req.params.messageId).maybeSingle();
    if (selectedError) throw selectedError;
    if (!selected || selected.role !== "assistant") return res.status(404).json({ success: false, error: "Reply variant not found" });
    await requireOwnedSession(selected.session_id, req.user.id);
    const { data: assistants, error: assistantsError } = await supabase.from("messages")
      .select("id,replaces_message_id,created_at").eq("session_id", selected.session_id)
      .eq("role", "assistant").eq("is_visible", true).order("created_at", { ascending: true });
    if (assistantsError) throw assistantsError;
    const byId = new Map((assistants || []).map((message) => [message.id, message]));
    const rootOf = (message) => {
      let current = message;
      const seen = new Set();
      while (current?.replaces_message_id && byId.has(current.replaces_message_id) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.replaces_message_id);
      }
      return current?.id;
    };
    const rootId = rootOf(selected);
    const variantIds = (assistants || []).filter((message) => rootOf(message) === rootId).map((message) => message.id);
    if (variantIds.length < 2) return res.status(400).json({ success: false, error: "This reply has no alternatives" });
    const latestVariantTime = Math.max(...(assistants || []).filter((message) => variantIds.includes(message.id)).map((message) => new Date(message.created_at).getTime()));
    const { data: laterUser } = await supabase.from("messages").select("id").eq("session_id", selected.session_id)
      .eq("role", "user").eq("is_visible", true).eq("context_status", "active")
      .gt("created_at", new Date(latestVariantTime).toISOString()).limit(1).maybeSingle();
    if (laterUser) return res.status(409).json({ success: false, error: "继续聊天后不能再切换旧回复版本" });
    const { error: demoteError } = await supabase.from("messages").update({ context_status: "alternative" }).in("id", variantIds);
    if (demoteError) throw demoteError;
    const { error: selectError } = await supabase.from("messages").update({ context_status: "active" }).eq("id", selected.id);
    if (selectError) throw selectError;
    res.json({ success: true, selectedMessageId: selected.id, variantIds });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// Read-only preview of the exact context layers used by companion chat.
app.post("/prompt-preview", async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : null;
    const requestedCharacterId = typeof req.body.characterId === "string" ? req.body.characterId : null;
    const settings = await getSettings(req.user.id);

    let session = null;
    if (sessionId) session = await requireOwnedSession(sessionId, req.user.id);
    const character = session?.character_id
      ? await getOwnedCharacter(session.character_id, req.user.id)
      : requestedCharacterId
        ? await getOwnedCharacter(requestedCharacterId, req.user.id)
        : await getOrCreateDefaultCharacter(req.user.id);

    const [userProfile, promptDocuments, memoryResult, followUpResult, summaryResult, historyResult] = await Promise.all([
      getOrCreateUserProfile(req.user.id),
      loadPromptDocuments(req.user.id, character.id),
      supabase.from("memories").select("*")
        .eq("user_id", req.user.id).eq("character_id", character.id).eq("status", "active")
        .order("updated_at", { ascending: false }).limit(200),
      loadStatusFollowUps(req.user.id, character.id),
      sessionId
        ? supabase.from("session_memories").select("summary").eq("session_id", sessionId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sessionId
        ? supabase.from("messages").select("role,content").eq("session_id", sessionId).eq("is_visible", true).eq("context_status", "active")
          .order("created_at", { ascending: false }).limit(normalizeRecentMessageLimit(settings.recent_message_limit))
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (memoryResult.error) throw memoryResult.error;
    if (summaryResult.error) throw summaryResult.error;
    if (historyResult.error) throw historyResult.error;
    const continuity = await loadWindowContinuity(req.user.id, session);

    let recentMessages = [...(historyResult.data || [])].reverse();
    if (message) {
      recentMessages = [...recentMessages, { role: "user", content: message }]
        .slice(-normalizeRecentMessageLimit(settings.recent_message_limit));
    }
    const relevantMemories = rankMemories(memoryResult.data || [], message, 5);
    const conversationalFollowUps = followUpResult.filter((item) => ["active", "waiting"].includes(item.status));
    let relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, recentMessages, 1);
    }
    const onDemandDocuments = selectRelevantPromptDocuments(promptDocuments, message, 3);
    const recalledSharedDay = message ? await recallSharedDay({
      userId:req.user.id,characterId:character.id,sessionId,message,allowSemantic:false,writePointer:false,
    }).catch((error)=>{console.error("Prompt preview source recall failed:",error.message);return "";}) : "";
    const modelTarget = await getModelTarget({
      userId: req.user.id,
      purpose: "companion_chat",
      legacyModel: settings.model,
    });
    const layers = buildModelContextLayers({
      systemPrompt: settings.system_prompt
        ? `User-configured system instructions:\n${settings.system_prompt}`
        : "",
      promptDocuments: formatPromptDocuments(promptDocuments),
      currentContext: formatCurrentTime(),
      topicDocuments: formatRetrievedPromptDocuments(onDemandDocuments),
      characterProfile: formatCharacterProfile(character),
      userProfile: formatUserProfile(userProfile),
      windowContinuity: formatWindowContinuity(continuity.handoff, continuity.tailMessages),
      recalledSharedDay,
      followUps: formatFollowUps(relevantFollowUps),
      longTermMemories: formatLongTermMemories(relevantMemories),
      memorySummary: summaryResult.data?.summary,
      recentMessages,
    }).map((layer, index) => ({
      ...layer,
      order: index + 1,
      characters: layer.content.length,
      estimatedTokens: estimateTokens(layer.content),
    }));

    res.json({
      success: true,
      preview: {
        model: modelTarget.model,
        connectionId: modelTarget.connectionId,
        character: { id: character.id, name: character.name },
        sessionId,
        hypotheticalMessage: message,
        layers,
        totals: {
          layers: layers.length,
          characters: layers.reduce((total, layer) => total + layer.characters, 0),
          estimatedTokens: layers.reduce((total, layer) => total + layer.estimatedTokens, 0),
        },
        documents: {
          always: promptDocuments.filter((document) => document.is_enabled
            && (!document.load_mode || document.load_mode === "always")
            && document.confirmation_status !== "suggested").map(({ id, name }) => ({ id, name })),
          onDemandMatched: onDemandDocuments.map(({ id, name }) => ({ id, name })),
        },
        notice: "Token counts are estimates. This preview does not call a model, spend API credit, persist the message, or update recall counters.",
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// Settings
app.get("/settings", async (req, res) => {
  try {
    res.json({ success: true, settings: toSettings(await getSettings(req.user.id)) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/settings", async (req, res) => {
  const updates = {};
  if (typeof req.body.systemPrompt === "string") updates.system_prompt = req.body.systemPrompt.trim();
  if (typeof req.body.model === "string" && req.body.model.trim()) updates.model = req.body.model.trim();
  if (Number.isFinite(req.body.temperature)) updates.temperature = req.body.temperature;
  if (Number.isInteger(req.body.maxTokens) && req.body.maxTokens > 0) updates.max_tokens = req.body.maxTokens;
  if (Number.isInteger(req.body.contextTokenThreshold) && req.body.contextTokenThreshold > 0) {
    updates.context_token_threshold = req.body.contextTokenThreshold;
  }
  if (Number.isInteger(req.body.recentMessageLimit) && req.body.recentMessageLimit >= 2) {
    updates.recent_message_limit = req.body.recentMessageLimit;
  }
  if (typeof req.body.summaryModel === "string" && req.body.summaryModel.trim()) {
    updates.summary_model = req.body.summaryModel.trim();
  }
  if (typeof req.body.timelineModel === "string" && req.body.timelineModel.trim()) {
    getModelProvider(req.body.timelineModel.trim());
    updates.timeline_model = req.body.timelineModel.trim();
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, error: "No valid settings were provided" });
  }

  try {
    await getSettings(req.user.id);
    const { data, error } = await supabase
      .from("user_settings")
      .update(updates)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, settings: toSettings(data) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User-defined API connections. Secrets remain write-only and server-side.
app.get("/api-feature-definitions", (req, res) => {
  res.json({ success: true, features: FEATURE_DEFINITIONS.filter((feature) => !feature.hidden) });
});

app.post("/memory-practice/segments/:segmentId/extract", async (req, res) => {
  let batch;
  try {
    const { data: segment, error } = await supabase.from("imported_conversation_segments").select("*")
      .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!segment) return res.status(404).json({ success: false, error: "Imported segment not found" });
    const settings = await getSettings(req.user.id);
    const [allDocuments, character, userProfile] = await Promise.all([
      loadPromptDocuments(req.user.id, segment.character_id),
      getOwnedCharacter(segment.character_id, req.user.id),
      getOrCreateUserProfile(req.user.id),
    ]);
    const documents = allDocuments.filter((document) => document.load_mode !== "archive");
    const identities = { characterName: character.name || "季疏", userName: userProfile.display_name || "年妤", userAliases: ["妤妤"] };
    const sourceMessages = (segment.raw_messages || []).map((message) => ({
      role: message.role,
      content: cleanClaudeSay(message.role, message.content),
    }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");

    async function extractPart({ prompt, parser, maxTokens }) {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const raw = await callModel({
          purpose: "long_term_memory_extraction",
          model: settings.summary_model,
          userId: req.user.id,
          temperature: 0.05,
          maxTokens,
          responseFormat: "json_object",
          thinking: "disabled",
          messages: [
            { role: "system", content: "You are a conservative documentary memory extractor. Follow the requested JSON schema exactly." },
            { role: "user", content: prompt },
            ...(attempt === 2 ? [{ role: "user", content: "The previous output was incomplete or failed strict validation. Return a shorter, complete JSON object and follow the schema exactly." }] : []),
          ],
        });
          return parser(raw, sourceMessages);
        } catch (extractionError) {
          lastError = extractionError;
        }
      }
      const failure = new Error("记忆模型连续两次没有返回完整、合格的结构化结果。请换一个更短的片段后重试。");
      failure.cause = lastError;
      throw failure;
    }
    const experiencePart = await extractPart({
      prompt: buildExperienceExtractionPrompt(numberedTranscript, segment.started_at, segment.ended_at, identities),
      parser: parseExperienceExtraction,
      maxTokens: 2200,
    });
    const supportPart = await extractPart({
      prompt: buildSupportExtractionPrompt(numberedTranscript, segment.started_at, segment.ended_at, documents, identities),
      parser: parseSupportExtraction,
      maxTokens: 2200,
    });
    const extraction = { experiences: experiencePart.experiences, knowledgeNotes: supportPart.knowledgeNotes, handoff: supportPart.handoff };

    const target = await getModelTarget({ userId: req.user.id, purpose: "long_term_memory_extraction", legacyModel: settings.summary_model });
    const { data: workspace, error: workspaceError } = await supabase.from("memory_import_workspaces").upsert({
      user_id: req.user.id, character_id: segment.character_id, import_id: segment.import_id, updated_at: new Date().toISOString(),
    }, { onConflict: "import_id" }).select().single();
    if (workspaceError) throw workspaceError;
    const { data: savedBatch, error: batchError } = await supabase.from("memory_processing_batches").upsert({
      user_id: req.user.id,
      character_id: segment.character_id,
      import_id: segment.import_id,
      segment_id: segment.id,
      workspace_id: workspace.id,
      status: "extracted",
      extraction_model: target.model,
      verification_model: null,
      verified_at: null,
    }, { onConflict: "segment_id" }).select().single();
    if (batchError) throw batchError;
    batch = savedBatch;

    await Promise.all([
      supabase.from("memory_experience_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_knowledge_notes").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_handoff_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
    ]);
    const experienceRows = extraction.experiences.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      title: item.title, narrative_markdown: item.narrativeMarkdown, current_state: item.currentState,
      index_summary: item.indexSummary, search_anchors: item.anchors, evidence_refs: item.evidence,
    }));
    const documentIds = new Set(documents.map((document) => document.id));
    const noteRows = extraction.knowledgeNotes.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      suggested_document_name: item.suggestedDocumentName, note_markdown: item.noteMarkdown, evidence_refs: item.evidence,
      target_document_id: documentIds.has(item.suggestedDocumentId) ? item.suggestedDocumentId : null,
    }));
    const handoffRows = extraction.handoff ? [{
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      body_markdown: extraction.handoff.bodyMarkdown, current_state: extraction.handoff.currentState,
      topics: extraction.handoff.topics, open_loops: extraction.handoff.openLoops,
      continuation_guidance: extraction.handoff.continuationGuidance, evidence_refs: extraction.handoff.evidence,
    }] : [];
    const [{ data: experiences, error: experienceError }, { data: notes, error: noteError }, { data: handoffs, error: handoffError }] = await Promise.all([
      experienceRows.length ? supabase.from("memory_experience_candidates").insert(experienceRows).select("*") : { data: [], error: null },
      noteRows.length ? supabase.from("memory_knowledge_notes").insert(noteRows).select("*") : { data: [], error: null },
      handoffRows.length ? supabase.from("memory_handoff_candidates").insert(handoffRows).select("*") : { data: [], error: null },
    ]);
    if (experienceError || noteError || handoffError) throw experienceError || noteError || handoffError;
    res.json({ success: true, batch, experiences: experiences || [], knowledgeNotes: notes || [], handoffs: handoffs || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/memory-practice/batches", async (req, res) => {
  try {
    const { data, error } = await supabase.from("memory_processing_batches")
      .select("*, imported_conversation_segments(sequence,started_at,ended_at), memory_experience_candidates(*), memory_knowledge_notes(*), memory_handoff_candidates(*), memory_knowledge_patch_candidates(*)")
      .eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, batches: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/memory-practice/workspaces", async (req, res) => {
  try {
    const { data: workspaces, error: workspaceError } = await supabase.from("memory_import_workspaces")
      .select("*, conversation_imports(title,source_filename,message_count,segment_count,created_at)")
      .eq("user_id", req.user.id).order("updated_at", { ascending: false });
    if (workspaceError) throw workspaceError;
    const workspaceIds = (workspaces || []).map((workspace) => workspace.id);
    const characterIds = [...new Set((workspaces || []).map((workspace) => workspace.character_id))];
    const [{ data: batches, error: batchError }, { data: patches, error: patchError }, { data: documents, error: documentError }] = await Promise.all([
      workspaceIds.length ? supabase.from("memory_processing_batches").select("id,workspace_id,segment_id,memory_experience_candidates(id),memory_knowledge_notes(id,status,source_kind),memory_handoff_candidates(id)").in("workspace_id", workspaceIds).eq("user_id", req.user.id) : { data: [], error: null },
      workspaceIds.length ? supabase.from("memory_document_patch_candidates").select("*").in("workspace_id", workspaceIds).eq("user_id", req.user.id) : { data: [], error: null },
      characterIds.length ? supabase.from("prompt_documents").select("id,character_id,name,document_type,load_mode").in("character_id", characterIds).eq("user_id", req.user.id).neq("load_mode", "archive").order("sort_order") : { data: [], error: null },
    ]);
    if (batchError || patchError || documentError) throw batchError || patchError || documentError;
    const batchIds = (batches || []).map((batch) => batch.id);
    const { data: notes, error: noteError } = batchIds.length
      ? await supabase.from("memory_knowledge_notes").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted").order("created_at")
      : { data: [], error: null };
    if (noteError) throw noteError;
    res.json({
      success: true,
      documents: documents || [],
      workspaces: (workspaces || []).map((workspace) => {
        const workspaceBatches = (batches || []).filter((batch) => batch.workspace_id === workspace.id);
        const ids = new Set(workspaceBatches.map((batch) => batch.id));
        return {
          ...workspace,
          extractedSegmentCount: workspaceBatches.length,
          extractedSegmentIds: workspaceBatches.map((batch) => batch.segment_id),
          experienceCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_experience_candidates?.length || 0), 0),
          extractedNoteCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_knowledge_notes || []).filter((note) => note.status === "extracted").length, 0),
          handoffCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_handoff_candidates?.length || 0), 0),
          segmentResults: workspaceBatches.map((batch) => ({
            segmentId: batch.segment_id,
            experienceCount: batch.memory_experience_candidates?.length || 0,
            noteCount: (batch.memory_knowledge_notes || []).filter((note) => note.source_kind === "segment_extraction" && note.status === "extracted").length,
            handoffCount: batch.memory_handoff_candidates?.length || 0,
          })),
          notes: (notes || []).filter((note) => ids.has(note.batch_id)),
          patches: (patches || []).filter((patch) => patch.workspace_id === workspace.id),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/memory-practice/workspaces/:workspaceId/distill", async (req, res) => {
  try {
    const { data: workspace, error } = await supabase.from("memory_import_workspaces").select("*")
      .eq("id", req.params.workspaceId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!workspace) return res.status(404).json({ success: false, error: "整份导入工作区不存在" });
    const { data: batches, error: batchError } = await supabase.from("memory_processing_batches").select("id,segment_id")
      .eq("workspace_id", workspace.id).eq("user_id", req.user.id);
    if (batchError) throw batchError;
    const batchIds = (batches || []).map((batch) => batch.id);
    if (!batchIds.length) return res.status(400).json({ success: false, error: "请先提取至少一个片段" });
    const [{ data: experiences, error: experienceError }, documents, character, userProfile] = await Promise.all([
      supabase.from("memory_experience_candidates").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).order("created_at"),
      loadPromptDocuments(req.user.id, workspace.character_id),
      getOwnedCharacter(workspace.character_id, req.user.id),
      getOrCreateUserProfile(req.user.id),
    ]);
    if (experienceError) throw experienceError;
    if (!experiences?.length) return res.status(400).json({ success: false, error: "已提取片段中还没有经历素材" });
    const activeDocuments = documents.filter((document) => document.load_mode !== "archive");
    const identities = { characterName: character.name || "季疏", userName: userProfile.display_name || "年妤", userAliases: ["妤妤"] };
    if (!activeDocuments.length) return res.status(400).json({ success: false, error: "请先创建至少一份可用的 Markdown 知识文件" });
    const batchById = new Map((batches || []).map((batch) => [batch.id, batch]));
    const experienceById = new Map(experiences.map((item) => [item.id, item]));
    const settings = await getSettings(req.user.id);
    const generated = [];
    for (let offset = 0; offset < experiences.length; offset += 20) {
      const group = experiences.slice(offset, offset + 20);
      const material = group.map((item) => ({
        id: item.id,
        segment_id: batchById.get(item.batch_id)?.segment_id,
        title: item.title,
        index_summary: item.index_summary,
        current_state: item.current_state,
        search_anchors: item.search_anchors,
        evidence: (item.evidence_refs || []).slice(0, 4).map((entry) => ({ role: entry.role, quote: String(entry.quote || "").slice(0, 600) })),
      }));
      const raw = await callModel({
        purpose: "memory_verification", model: settings.summary_model, userId: req.user.id,
        temperature: 0, maxTokens: 5000, responseFormat: "json_object", thinking: "disabled",
        messages: [
          { role: "system", content: "You conservatively distill grounded experiences into Chinese Knowledge File notes. Return complete JSON only." },
          { role: "user", content: buildImportDistillationPrompt({ experiences: material, documents: activeDocuments, identities }) },
        ],
      });
      generated.push(...parseImportDistillation(raw, group.map((item) => item.id), activeDocuments, identities));
    }
    const { error: deleteError } = await supabase.from("memory_knowledge_notes").delete()
      .in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted");
    if (deleteError) throw deleteError;
    const rows = generated.map((item) => {
      const sources = item.experienceIds.map((id) => experienceById.get(id)).filter(Boolean);
      const evidence = sources.flatMap((source) => (source.evidence_refs || []).map((entry) => ({
        ...entry,
        experienceId: source.id,
        experienceTitle: source.title,
        segmentId: batchById.get(source.batch_id)?.segment_id,
      }))).slice(0, 20);
      return {
        batch_id: sources[0].batch_id, user_id: req.user.id, character_id: workspace.character_id,
        suggested_document_name: item.suggestedDocumentName, note_markdown: item.noteMarkdown,
        target_document_id: item.suggestedDocumentId, evidence_refs: evidence,
        source_kind: "import_distillation", source_experience_ids: item.experienceIds,
      };
    });
    const { data: saved, error: saveError } = rows.length
      ? await supabase.from("memory_knowledge_notes").insert(rows).select("*")
      : { data: [], error: null };
    if (saveError) throw saveError;
    await supabase.from("memory_import_workspaces").update({ updated_at: new Date().toISOString() })
      .eq("id", workspace.id).eq("user_id", req.user.id);
    res.json({ success: true, notes: saved || [], experienceCount: experiences.length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.patch("/memory-practice/notes/:noteId/target", async (req, res) => {
  try {
    const targetDocumentId = typeof req.body.targetDocumentId === "string" && req.body.targetDocumentId ? req.body.targetDocumentId : null;
    const { data: note, error } = await supabase.from("memory_knowledge_notes").select("id,character_id")
      .eq("id", req.params.noteId).eq("user_id", req.user.id).eq("status", "extracted").maybeSingle();
    if (error) throw error;
    if (!note) return res.status(404).json({ success: false, error: "Knowledge material not found" });
    if (targetDocumentId) {
      const { data: document, error: documentError } = await supabase.from("prompt_documents").select("id")
        .eq("id", targetDocumentId).eq("user_id", req.user.id).eq("character_id", note.character_id).neq("load_mode", "archive").maybeSingle();
      if (documentError) throw documentError;
      if (!document) return res.status(400).json({ success: false, error: "Choose an existing Knowledge File for this companion" });
    }
    const { data: saved, error: saveError } = await supabase.from("memory_knowledge_notes").update({ target_document_id: targetDocumentId })
      .eq("id", note.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    res.json({ success: true, note: saved });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/memory-practice/workspaces/:workspaceId/merge", async (req, res) => {
  try {
    const { data: workspace, error } = await supabase.from("memory_import_workspaces").select("*")
      .eq("id", req.params.workspaceId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!workspace) return res.status(404).json({ success: false, error: "Weekly memory workspace not found" });
    const { data: batches, error: batchError } = await supabase.from("memory_processing_batches").select("id,segment_id")
      .eq("workspace_id", workspace.id).eq("user_id", req.user.id);
    if (batchError) throw batchError;
    const batchIds = (batches || []).map((batch) => batch.id);
    const { data: notes, error: noteError } = batchIds.length
      ? await supabase.from("memory_knowledge_notes").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted").not("target_document_id", "is", null)
      : { data: [], error: null };
    if (noteError) throw noteError;
    if (!notes?.length) return res.status(400).json({ success: false, error: "请先把至少一条素材归入已有 Knowledge File" });
    const documentIds = [...new Set(notes.map((note) => note.target_document_id))];
    if (documentIds.length > 10) return res.status(400).json({ success: false, error: "一次最多合并 10 份 Knowledge File" });
    const { data: documents, error: documentError } = await supabase.from("prompt_documents").select("*")
      .in("id", documentIds).eq("user_id", req.user.id).eq("character_id", workspace.character_id).neq("load_mode", "archive");
    if (documentError) throw documentError;
    if ((documents || []).length !== documentIds.length) return res.status(400).json({ success: false, error: "部分目标 Knowledge File 已不存在或已归档" });
    const settings = await getSettings(req.user.id);
    const target = await getModelTarget({ userId: req.user.id, purpose: "memory_verification", legacyModel: settings.summary_model });
    const generated = [];
    for (const document of documents) {
      const routedNotes = notes.filter((note) => note.target_document_id === document.id);
      const routedBatchIds = new Set(routedNotes.map((note) => note.batch_id));
      const materialIds = routedNotes.map((_, index) => `N${index + 1}`);
      const prompt = buildDocumentMergePrompt({
        document, notes: routedNotes, mentionCount: routedNotes.length, segmentCount: routedBatchIds.size,
      });
      if (prompt.length > 140000) return res.status(400).json({ success: false, error: `“${document.name}”的本周素材过多，需要先分批压缩` });
      const raw = await callModel({
        purpose: "memory_verification", model: settings.summary_model, userId: req.user.id,
        temperature: 0, maxTokens: 9000, responseFormat: "json_object", thinking: "disabled",
        messages: [
          { role: "system", content: "You are a conservative editor of one user-maintained Knowledge File. Return complete JSON only." },
          { role: "user", content: prompt },
        ],
      });
      const merged = parseDocumentMerge(raw, materialIds);
      if (merged.proposedContent === document.content.trim()) continue;
      const sourceNoteIds = merged.usedMaterialIds.map((id) => routedNotes[Number(id.slice(1)) - 1]?.id).filter(Boolean);
      const { data: saved, error: saveError } = await supabase.from("memory_document_patch_candidates").upsert({
        workspace_id: workspace.id, user_id: req.user.id, character_id: workspace.character_id,
        document_id: document.id, document_name: document.name, previous_content: document.content,
        proposed_content: merged.proposedContent, change_summary: merged.changeSummary, merge_reason: merged.why,
        source_note_ids: sourceNoteIds, mention_count: routedNotes.length, segment_count: routedBatchIds.size,
        review_status: "suggested", reviewed_at: null,
      }, { onConflict: "workspace_id,document_id" }).select().single();
      if (saveError) throw saveError;
      generated.push(saved);
    }
    const { error: workspaceError } = await supabase.from("memory_import_workspaces").update({
      status: "review", updated_at: new Date().toISOString(),
    }).eq("id", workspace.id).eq("user_id", req.user.id);
    if (workspaceError) throw workspaceError;
    res.json({ success: true, patches: generated, model: target.model });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/memory-practice/document-patches/:patchId/confirm", async (req, res) => {
  try {
    const { data: patch, error } = await supabase.from("memory_document_patch_candidates").select("*")
      .eq("id", req.params.patchId).eq("user_id", req.user.id).eq("review_status", "suggested").maybeSingle();
    if (error) throw error;
    if (!patch) return res.status(404).json({ success: false, error: "Suggested document change not found" });
    const { data: document, error: documentError } = await supabase.from("prompt_documents").select("*")
      .eq("id", patch.document_id).eq("user_id", req.user.id).eq("character_id", patch.character_id).maybeSingle();
    if (documentError) throw documentError;
    if (!document) return res.status(404).json({ success: false, error: "Target Knowledge File no longer exists" });
    if (document.content !== patch.previous_content) {
      return res.status(409).json({ success: false, error: "这份 Knowledge File 在预览生成后被修改过。请重新生成合并预览，系统不会覆盖较新的内容。" });
    }
    const { data: savedDocument, error: saveError } = await supabase.from("prompt_documents").update({
      content: patch.proposed_content, confirmation_status: "confirmed", updated_at: new Date().toISOString(),
    }).eq("id", document.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    const { data: reviewed, error: reviewError } = await supabase.from("memory_document_patch_candidates").update({
      review_status: "confirmed", reviewed_at: new Date().toISOString(),
    }).eq("id", patch.id).eq("user_id", req.user.id).select().single();
    if (reviewError) throw reviewError;
    if (patch.source_note_ids?.length) {
      const { error: noteError } = await supabase.from("memory_knowledge_notes").update({ status: "merged" })
        .in("id", patch.source_note_ids).eq("user_id", req.user.id);
      if (noteError) throw noteError;
    }
    const { count, error: countError } = await supabase.from("memory_document_patch_candidates")
      .select("id", { count: "exact", head: true }).eq("workspace_id", patch.workspace_id).eq("user_id", req.user.id).eq("review_status", "suggested");
    if (countError) throw countError;
    if (!count) await supabase.from("memory_import_workspaces").update({ status: "applied", updated_at: new Date().toISOString() })
      .eq("id", patch.workspace_id).eq("user_id", req.user.id);
    res.json({ success: true, patch: reviewed, document: savedDocument });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post("/memory-practice/document-patches/:patchId/reject", async (req, res) => {
  const { data, error } = await supabase.from("memory_document_patch_candidates").update({
    review_status: "rejected", reviewed_at: new Date().toISOString(),
  }).eq("id", req.params.patchId).eq("user_id", req.user.id).eq("review_status", "suggested").select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Suggested document change not found" });
  res.json({ success: true, patch: data });
});

app.post("/memory-practice/batches/:batchId/verify", async (req, res) => {
  try {
    const { data: batch, error } = await supabase.from("memory_processing_batches").select("*")
      .eq("id", req.params.batchId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!batch) return res.status(404).json({ success: false, error: "Memory batch not found" });
    const [{ data: segment, error: segmentError }, { data: experiences, error: experienceError }, { data: notes, error: noteError }] = await Promise.all([
      supabase.from("imported_conversation_segments").select("*").eq("id", batch.segment_id).eq("user_id", req.user.id).maybeSingle(),
      supabase.from("memory_experience_candidates").select("*").eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_knowledge_notes").select("*").eq("batch_id", batch.id).eq("user_id", req.user.id),
    ]);
    if (segmentError || experienceError || noteError) throw segmentError || experienceError || noteError;
    if (!segment) throw new Error("The source segment for this batch no longer exists");
    const documents = await loadPromptDocuments(req.user.id, batch.character_id);
    const suggestedNames = (notes || []).map((item) => item.suggested_document_name.trim().toLocaleLowerCase());
    const relevantDocuments = documents.filter((document) => suggestedNames.some((name) => {
      const documentName = document.name.trim().toLocaleLowerCase();
      return name.includes(documentName) || documentName.includes(name);
    })).slice(0, 5);
    const sourceMessages = (segment.raw_messages || []).map((message) => ({ role: message.role, content: cleanClaudeSay(message.role, message.content) }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");
    const settings = await getSettings(req.user.id);
    const raw = await callModel({
      purpose: "memory_verification",
      model: settings.summary_model,
      userId: req.user.id,
      temperature: 0,
      maxTokens: 7000,
      responseFormat: "json_object",
      thinking: "disabled",
      messages: [
        { role: "system", content: "You are a strict documentary fact checker and knowledge-file editor. Return JSON only." },
        { role: "user", content: buildVerificationPrompt({ numberedTranscript, experiences: experiences || [], knowledgeNotes: notes || [], documents: relevantDocuments }) },
      ],
    });
    const verification = parseMemoryVerification(raw, sourceMessages, (experiences || []).map((item) => item.id), relevantDocuments);
    await supabase.from("memory_knowledge_patch_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id).eq("review_status", "suggested");
    for (const review of verification.experienceReviews) {
      const { error: updateError } = await supabase.from("memory_experience_candidates").update({ verification_status: review.verdict, verification_notes: review.correctionReason })
        .eq("id", review.candidateId).eq("batch_id", batch.id).eq("user_id", req.user.id);
      if (updateError) throw updateError;
    }
    const patchRows = verification.knowledgePatches.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: batch.character_id,
      document_id: item.documentId, document_name: item.documentName, previous_content: item.previousContent,
      proposed_content: item.proposedContent, change_summary: item.changeSummary, evidence_refs: item.evidence,
    }));
    const { data: patches, error: patchError } = patchRows.length
      ? await supabase.from("memory_knowledge_patch_candidates").insert(patchRows).select("*")
      : { data: [], error: null };
    if (patchError) throw patchError;
    const target = await getModelTarget({ userId: req.user.id, purpose: "memory_verification", legacyModel: settings.summary_model });
    const { data: savedBatch, error: batchError } = await supabase.from("memory_processing_batches").update({
      status: "verified", verification_model: target.model, verified_at: new Date().toISOString(),
    }).eq("id", batch.id).eq("user_id", req.user.id).select().single();
    if (batchError) throw batchError;
    res.json({ success: true, batch: savedBatch, patches: patches || [], experienceReviews: verification.experienceReviews });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/api-connections", async (req, res) => {
  try {
    const { data, error } = await supabase.from("api_connections").select("*")
      .eq("user_id", req.user.id).order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ success: true, connections: (data || []).map(safeConnectionView) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api-usage-events", async (req, res) => {
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

app.get("/api-connections/:connectionId/models", async (req, res) => {
  try {
    const { data: connection, error } = await supabase.from("api_connections").select("*")
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!connection) return res.status(404).json({ success: false, error: "Connection not found" });
    if (!connection.enabled) return res.status(400).json({ success: false, error: "Enable this connection before loading models" });

    const cached = modelCatalogCache.get(connection.id);
    if (cached && Date.now() - cached.loadedAt < MODEL_CATALOG_TTL_MS) {
      return res.json({ success: true, models: cached.models, cached: true, loadedAt: new Date(cached.loadedAt).toISOString() });
    }

    const endpoint = modelCatalogEndpoint(connection.base_url, connection.api_format);
    await validatePublicConnectionUrl(endpoint);
    const headers = connection.api_format === "anthropic"
      ? { "x-api-key": decryptSecret(connection.encrypted_key), "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${decryptSecret(connection.encrypted_key)}` };
    const response = await fetch(endpoint, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamMessage = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`Model list request failed: ${upstreamMessage}`);
    }
    const models = normalizeModelCatalog(payload);
    if (!models.length) throw new Error("This connection returned no usable model list; you can still enter a model ID manually");
    const loadedAt = Date.now();
    modelCatalogCache.set(connection.id, { models, loadedAt });
    res.json({ success: true, models, cached: false, loadedAt: new Date(loadedAt).toISOString() });
  } catch (error) {
    const message = error.name === "TimeoutError" ? "Loading models timed out; check the connection or enter a model ID manually" : error.message;
    res.status(502).json({ success: false, error: message });
  }
});

app.post("/api-connections", async (req, res) => {
  const label = textUpdate(req.body, "label", 80);
  const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  const apiFormat = typeof req.body.apiFormat === "string" ? req.body.apiFormat : "";
  if (!label || !apiKey || !API_FORMATS.has(apiFormat)) {
    return res.status(400).json({ success: false, error: "Name, API key, and a supported API format are required" });
  }
  try {
    const baseUrl = await validatePublicConnectionUrl(req.body.baseUrl);
    const { data, error } = await supabase.from("api_connections").insert({
      user_id: req.user.id,
      label,
      base_url: baseUrl,
      encrypted_key: encryptSecret(apiKey),
      api_format: apiFormat,
      notes: textUpdate(req.body, "notes", 1000) || "",
      enabled: req.body.enabled !== false,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, connection: safeConnectionView(data) });
  } catch (error) {
    const status = error.code === "23505" ? 409 : (/^Connection URL/.test(error.message) ? 400 : 500);
    res.status(status).json({ success: false, error: status === 409 ? "A connection with this name already exists" : error.message });
  }
});

app.patch("/api-connections/:connectionId", async (req, res) => {
  try {
    const { data: current, error: currentError } = await supabase.from("api_connections").select("*")
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ success: false, error: "Connection not found" });

    const updates = { updated_at: new Date().toISOString() };
    const label = textUpdate(req.body, "label", 80);
    const notes = textUpdate(req.body, "notes", 1000);
    if (label !== undefined) {
      if (!label) return res.status(400).json({ success: false, error: "Connection name cannot be empty" });
      updates.label = label;
    }
    if (notes !== undefined) updates.notes = notes;
    if (typeof req.body.enabled === "boolean") updates.enabled = req.body.enabled;
    if (typeof req.body.apiFormat === "string") {
      if (!API_FORMATS.has(req.body.apiFormat)) return res.status(400).json({ success: false, error: "Unsupported API format" });
      updates.api_format = req.body.apiFormat;
    }
    if (req.body.baseUrl !== undefined) updates.base_url = await validatePublicConnectionUrl(req.body.baseUrl);
    if (req.body.apiKey !== undefined) {
      const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
      if (!apiKey) return res.status(400).json({ success: false, error: "API key cannot be empty" });
      updates.encrypted_key = encryptSecret(apiKey);
    }

    const { data, error } = await supabase.from("api_connections").update(updates)
      .eq("id", current.id).eq("user_id", req.user.id).select().single();
    if (error) throw error;
    res.json({ success: true, connection: safeConnectionView(data) });
  } catch (error) {
    const status = error.code === "23505" ? 409 : (/^Connection URL/.test(error.message) ? 400 : 500);
    res.status(status).json({ success: false, error: status === 409 ? "A connection with this name already exists" : error.message });
  }
});

app.delete("/api-connections/:connectionId", async (req, res) => {
  try {
    const { count, error: routeError } = await supabase.from("api_feature_routes")
      .select("purpose", { count: "exact", head: true })
      .eq("user_id", req.user.id).eq("connection_id", req.params.connectionId);
    if (routeError) throw routeError;
    if (count) return res.status(409).json({ success: false, error: "Move assigned features before deleting this connection" });
    const { data, error } = await supabase.from("api_connections").delete()
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: "Connection not found" });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api-feature-routes", async (req, res) => {
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

app.put("/api-feature-routes/:purpose", async (req, res) => {
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

app.get("/settings/credentials", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("model_credentials")
      .select("provider, updated_at")
      .eq("user_id", req.user.id);
    if (error) throw error;
    const configured = Object.fromEntries(MODEL_PROVIDERS.map(({ name }) => [name, false]));
    data.forEach(({ provider, updated_at }) => { configured[provider] = { configured: true, updatedAt: updated_at }; });
    res.json({ success: true, credentials: configured });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put("/settings/credentials/:provider", async (req, res) => {
  const provider = req.params.provider;
  const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  if (!MODEL_PROVIDERS.some((item) => item.name === provider)) {
    return res.status(400).json({ success: false, error: "Unsupported model provider" });
  }
  if (!apiKey) return res.status(400).json({ success: false, error: "An API key is required" });

  try {
    const { error } = await supabase.from("model_credentials").upsert({
      user_id: req.user.id,
      provider,
      encrypted_key: encryptSecret(apiKey),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,provider" });
    if (error) throw error;
    res.json({ success: true, provider, configured: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/settings/credentials/:provider", async (req, res) => {
  const provider = req.params.provider;
  if (!MODEL_PROVIDERS.some((item) => item.name === provider)) {
    return res.status(400).json({ success: false, error: "Unsupported model provider" });
  }
  try {
    const { error } = await supabase.from("model_credentials").delete()
      .eq("user_id", req.user.id).eq("provider", provider);
    if (error) throw error;
    res.json({ success: true, provider, configured: false });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function completedChatRequestResponse(request, userId) {
  const [{ data: assistant, error: assistantError }, { data: session, error: sessionError }] = await Promise.all([
    supabase.from("messages").select("id,content,generation_status,finish_reason,continues_message_id").eq("id", request.assistant_message_id).maybeSingle(),
    supabase.from("sessions").select("id,name").eq("id", request.session_id).eq("user_id", userId).maybeSingle(),
  ]);
  if (assistantError || sessionError) throw assistantError || sessionError;
  if (!assistant || !session) throw new Error("Completed chat result is no longer available");
  return {
    success: true,
    requestStatus: request.status,
    clientRequestId: request.id,
    sessionId: session.id,
    title: session.name,
    reply: assistant.content,
    messageId: assistant.id,
    generationStatus: assistant.generation_status,
    finishReason: assistant.finish_reason,
    continuesMessageId: assistant.continues_message_id,
    recovered: true,
  };
}

app.get("/chat-requests/:requestId", async (req, res) => {
  if (!validUuid(req.params.requestId)) return res.status(400).json({ success: false, error: "Invalid request ID" });
  try {
    const { data: request, error } = await supabase.from("chat_requests").select("*")
      .eq("id", req.params.requestId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ success: false, error: "Chat request not found" });
    if (["succeeded","truncated"].includes(request.status)) return res.json(await completedChatRequestResponse(request, req.user.id));
    res.json({ success: true, requestStatus: request.status, clientRequestId: request.id, sessionId: request.session_id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const activeChatControllers = new Map();

app.post("/chat-requests/:requestId/cancel", async (req, res) => {
  if (!validUuid(req.params.requestId)) return res.status(400).json({ success: false, error: "Invalid request ID" });
  try {
    const { data: request, error } = await supabase.from("chat_requests").select("id,status")
      .eq("id", req.params.requestId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ success: false, error: "Chat request not found" });
    activeChatControllers.get(request.id)?.abort();
    res.json({ success: true, requestStatus: request.status === "pending" ? "cancelling" : request.status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Core chat: persist user message, assemble context, call model, and keep retries idempotent.
app.post("/chat", async (req, res) => {
  const requestStartedClock = Date.now();
  const message = typeof req.body.message === "string" ? req.body.message : "";
  if (!message.trim()) return res.status(400).json({ success: false, error: "A message is required" });
  const clientRequestId = req.body.clientRequestId;
  if (!validUuid(clientRequestId)) return res.status(400).json({ success: false, error: "A valid clientRequestId is required" });

  const wantsStream = req.headers.accept?.includes("text/event-stream");
  const operation = ["send", "regenerate", "edit", "continue"].includes(req.body.operation) ? req.body.operation : "send";
  const targetMessageId = req.body.targetMessageId;
  const abortController = new AbortController();
  let trackedRequest = null;
  let streamedReply = "";
  let streamClosed = false;
  let modelCompletion = { complete: false, status: "unknown", finishReason: null };
  const sendStreamEvent = (event, data) => {
    if (!wantsStream || res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }
  try {
    const { data: existingRequest, error: existingRequestError } = await supabase.from("chat_requests").select("*")
      .eq("id", clientRequestId).eq("user_id", req.user.id).maybeSingle();
    if (existingRequestError) throw existingRequestError;
    if (existingRequest?.request_text !== undefined && existingRequest.request_text !== message) {
      if (wantsStream) {
        sendStreamEvent("error", { error: "This retry ID belongs to different text" });
        return res.end();
      }
      return res.status(409).json({ success: false, error: "This retry ID belongs to different text" });
    }
    if (["succeeded","truncated"].includes(existingRequest?.status)) {
      const completed = await completedChatRequestResponse(existingRequest, req.user.id);
      if (wantsStream) {
        sendStreamEvent("done", completed);
        return res.end();
      }
      return res.json(completed);
    }
    if (existingRequest?.status === "pending") {
      const pending = { success: true, requestStatus: "pending", clientRequestId, sessionId: existingRequest.session_id };
      if (wantsStream) {
        sendStreamEvent("error", { ...pending, error: "这条回复仍在生成，请稍后再试。" });
        return res.end();
      }
      return res.status(202).json(pending);
    }

    let sessionId = existingRequest?.session_id || req.body.sessionId;
    let isNewSession = false;

    if (existingRequest) {
      req.sessionRecord = await requireOwnedSession(sessionId, req.user.id);
      const { data, error } = await supabase.from("chat_requests").update({
        status: "pending", error_code: null, updated_at: new Date().toISOString(), completed_at: null,
      }).eq("id", clientRequestId).eq("user_id", req.user.id).select().single();
      if (error) throw error;
      trackedRequest = data;
    } else if (!sessionId) {
      const session = await createSession(req.user.id, DEFAULT_SESSION_NAME, req.body.characterId);
      sessionId = session.id;
      req.sessionRecord = session;
      isNewSession = true;
    } else {
      req.sessionRecord = await requireOwnedSession(sessionId, req.user.id);
    }

    if (!trackedRequest) {
      const { data, error } = await supabase.from("chat_requests").insert({
        id: clientRequestId, user_id: req.user.id, session_id: sessionId, request_text: message, status: "pending",
      }).select().single();
      if (error) throw error;
      trackedRequest = data;
    }

    activeChatControllers.set(clientRequestId, abortController);

    if (operation !== "send") {
      const { data: target, error: targetError } = await supabase.from("messages")
        .select("id,session_id,role,content,created_at")
        .eq("id", targetMessageId).eq("session_id", sessionId).maybeSingle();
      if (targetError) throw targetError;
      const expectedRole = operation === "edit" ? "user" : "assistant";
      if (!target || target.role !== expectedRole) {
        const invalidTarget = new Error(`A valid ${expectedRole} target message is required`);
        invalidTarget.status = 400;
        throw invalidTarget;
      }
      if (operation === "edit") {
        const { error: updateError } = await supabase.from("messages").update({ content: message, context_status: "active" }).eq("id", target.id);
        if (updateError) throw updateError;
        const { error: discardError } = await supabase.from("messages").update({ context_status: "discarded", is_visible: false })
          .eq("session_id", sessionId).gt("created_at", target.created_at);
        if (discardError) throw discardError;
        trackedRequest.user_message_id = target.id;
        await supabase.from("chat_requests").update({ user_message_id: target.id }).eq("id", clientRequestId);
      } else if (operation === "regenerate") {
        const { error: alternativeError } = await supabase.from("messages").update({ context_status: "alternative" }).eq("id", target.id);
        if (alternativeError) throw alternativeError;
        const { data: precedingUser, error: precedingError } = await supabase.from("messages").select("id")
          .eq("session_id", sessionId).eq("role", "user").eq("context_status", "active")
          .lt("created_at", target.created_at).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (precedingError) throw precedingError;
        if (precedingUser) {
          trackedRequest.user_message_id = precedingUser.id;
          await supabase.from("chat_requests").update({ user_message_id: precedingUser.id }).eq("id", clientRequestId);
        }
      }
    }

    if (!trackedRequest.user_message_id && operation === "send") {
      const { data: userMessage, error: userMessageError } = await supabase
        .from("messages")
        .insert({ session_id: sessionId, role: "user", content: message, is_visible: true })
        .select("id").single();
      if (userMessageError) throw userMessageError;
      const { data, error } = await supabase.from("chat_requests").update({
        user_message_id: userMessage.id, updated_at: new Date().toISOString(),
      }).eq("id", clientRequestId).eq("user_id", req.user.id).select().single();
      if (error) throw error;
      trackedRequest = data;
    }

    const { error: heartbeatResetError } = await supabase.from("heartbeat_settings").update({
      last_chat_at: new Date().toISOString(),
      next_due_at: null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", req.user.id);
    if (heartbeatResetError) console.error("Heartbeat timer reset failed:", heartbeatResetError.code || "database_error");

    const [settings, character, userProfile] = await Promise.all([
      getSettings(req.user.id),
      req.sessionRecord.character_id
        ? getOwnedCharacter(req.sessionRecord.character_id, req.user.id)
        : getOrCreateDefaultCharacter(req.user.id),
      getOrCreateUserProfile(req.user.id),
    ]);
    const loadMemorySummary = async () => {
      try {
        return await maybeCompressMemory(sessionId, settings, req.user.id);
      } catch (compressionError) {
        console.error("Memory compression failed:", compressionError);
        const { data: existingMemory, error: memoryError } = await supabase.from("session_memories")
          .select("summary").eq("session_id", sessionId).maybeSingle();
        if (memoryError) throw memoryError;
        return existingMemory?.summary;
      }
    };
    const loadRecentHistory = async () => {
      const { data, error } = await supabase.from("messages").select("role, content")
        .eq("session_id", sessionId).eq("is_visible", true).eq("context_status", "active")
        .order("created_at", { ascending: false })
        .limit(normalizeRecentMessageLimit(settings.recent_message_limit));
      if (error) throw error;
      return data || [];
    };
    const [promptDocuments, continuity, relevantMemories, statusFollowUps, memorySummary, recentHistory, recalledSharedDay] = await Promise.all([
      loadPromptDocuments(req.user.id, character.id),
      loadWindowContinuity(req.user.id, req.sessionRecord),
      recallMemories(req.user.id, character.id, message).catch((error) => {
        console.error("Long-term memory recall failed:", error);
        return [];
      }),
      loadStatusFollowUps(req.user.id, character.id).catch((error) => {
        console.error("Follow-up recall failed:", error);
        return [];
      }),
      loadMemorySummary(),
      loadRecentHistory(),
      recallSharedDay({userId:req.user.id,characterId:character.id,sessionId,message,allowSemantic:true,writePointer:true}).catch((error)=>{
        console.error("Shared-day recall failed:",error.message); return "";
      }),
    ]);
    const onDemandDocuments = selectRelevantPromptDocuments(promptDocuments, message, 3);
    let relevantFollowUps = [];
    const conversationalFollowUps = statusFollowUps.filter((item) => ["active", "waiting"].includes(item.status));
    relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, recentHistory, 1);
    }
    const statusRelevantFollowUps = selectContextualFollowUps(statusFollowUps, message, recentHistory, 1);
    const historyChronological = [...recentHistory].reverse();
    const context = buildModelContext({
      systemPrompt: settings.system_prompt
        ? `User-configured system instructions:\n${settings.system_prompt}`
        : "",
      promptDocuments: formatPromptDocuments(promptDocuments),
      currentContext: formatCurrentTime(),
      topicDocuments: formatRetrievedPromptDocuments(onDemandDocuments),
      characterProfile: formatCharacterProfile(character),
      userProfile: formatUserProfile(userProfile),
      windowContinuity: formatWindowContinuity(continuity.handoff, continuity.tailMessages),
      recalledSharedDay,
      followUps: formatFollowUps(relevantFollowUps),
      longTermMemories: formatLongTermMemories(relevantMemories),
      memorySummary,
      recentMessages: historyChronological,
    });
    if (operation === "continue") {
      context.splice(Math.max(0, context.length - historyChronological.length), 0, {
        role: "system",
        content: "The immediately preceding assistant message was cut off by the transport or output limit. Continue that reply naturally from where it stopped. Do not repeat or rewrite the existing partial message; produce only the continuation as a new assistant message.",
      });
    }

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : settings.model;
    const preparationMs = Math.max(0, Date.now() - requestStartedClock);
    const reply = await callModel({
        purpose: "companion_chat",
        model: requestedModel,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        messages: context,
        userId: req.user.id,
        sessionId,
        signal: abortController.signal,
        preparationMs,
        onDelta: wantsStream ? (delta, complete) => {
          streamedReply = complete;
          sendStreamEvent("delta", { delta });
        } : undefined,
        onCompletion: (value) => { modelCompletion = value; },
      });

    const generationStatus = modelCompletion.complete
      ? "complete"
      : modelCompletion.status === "length" ? "truncated_length"
        : modelCompletion.status === "abnormal_eof" ? "truncated_eof" : "truncated_unknown";

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("messages")
      .insert({
        session_id: sessionId,
        role: "assistant",
        content: reply,
        is_visible: true,
        context_status: "active",
        generation_status: generationStatus,
        finish_reason: modelCompletion.finishReason,
        ...(operation === "continue" ? { continues_message_id: targetMessageId } : {}),
        ...(operation === "regenerate" ? { replaces_message_id: targetMessageId } : {}),
      })
      .select()
      .single();
    if (assistantMessageError) throw assistantMessageError;

    let title;
    if (isNewSession) {
      title = message.slice(0, 16) || DEFAULT_SESSION_NAME;
      void createTitle(requestedModel, message, reply, req.user.id).then(async (generatedTitle) => {
        const { error: titleError } = await supabase.from("sessions")
          .update({ name: generatedTitle, updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", req.user.id);
        if (titleError) console.error("Session title update failed:", titleError);
      }).catch((error) => console.error("Background title generation failed:", error));
    } else {
      void touchSession(sessionId, req.user.id).catch((error) => console.error("Session timestamp update failed:", error));
    }

    const ruleBasedSuggestion = suggestFollowUpStatus(statusRelevantFollowUps, message);
    const followUpStatusSuggestion = ruleBasedSuggestion
      ? { action: "update", ...ruleBasedSuggestion }
      : null;
    const explicitMemory = parseExplicitMemoryRequest(message);
    const explicitFollowUp = parseExplicitFollowUpRequest(message);
    let capturedMemoryId = null;
    if (explicitMemory) {
      try {
        const captured = await saveExplicitMemory({
          userId: req.user.id,
          characterId: character.id,
          sessionId,
          candidate: explicitMemory,
        });
        capturedMemoryId = captured.id;
      } catch (memoryError) {
        console.error("Explicit long-term memory save failed:", memoryError);
      }
    }
    let followUpCapture = explicitFollowUp ? "failed" : "none";
    if (explicitFollowUp) {
      try {
        await saveExplicitFollowUp({
          userId: req.user.id,
          characterId: character.id,
          sessionId,
          candidate: explicitFollowUp,
        });
        followUpCapture = "saved";
      } catch (followUpError) {
        console.error("Explicit follow-up save failed:", followUpError);
      }
    }

    const { error: requestUpdateError } = await supabase.from("chat_requests").update({
      status: modelCompletion.complete ? "succeeded" : "truncated",
      assistant_message_id: assistantMessage.id,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_code: null,
    }).eq("id", clientRequestId).eq("user_id", req.user.id);
    if (requestUpdateError) console.error("Chat request completion tracking failed:", requestUpdateError);
    if(operation==="send"&&(hasMorningMarker(message)||hasNightMarker(message))){
      setImmediate(()=>refreshSharedDaysAfterMarker(req.user.id,character.id).catch((reason)=>console.error("Marker shared-day refresh failed:",reason.message)));
    }

    const responsePayload = {
      success: true,
      requestStatus: "succeeded",
      clientRequestId,
      sessionId,
      title,
      reply,
      messageId: assistantMessage.id,
      memoryCapture: explicitMemory ? (capturedMemoryId ? "saved" : "failed") : "automatic_disabled",
      followUpCapture,
      followUpStatusSuggestion,
      operation,
      targetMessageId: targetMessageId || null,
      generationStatus,
      finishReason: modelCompletion.finishReason,
    };
    if (wantsStream) {
      sendStreamEvent(modelCompletion.complete ? "done" : "truncated", responsePayload);
      streamClosed = true;
      res.end();
    } else {
      res.json(responsePayload);
    }
  } catch (error) {
    console.error("Chat failed:", error);
    const cancelled = error?.name === "AbortError" || abortController.signal.aborted;
    if (operation === "regenerate" && targetMessageId && (!cancelled || !streamedReply.trim())) {
      const { error: restoreError } = await supabase.from("messages").update({ context_status: "active" }).eq("id", targetMessageId);
      if (restoreError) console.error("Original reply restore failed:", restoreError);
    }
    if (cancelled && trackedRequest?.session_id) {
      try {
        let partialMessage = null;
        if (streamedReply.trim()) {
          const { data, error: partialInsertError } = await supabase.from("messages").insert({
            session_id: trackedRequest.session_id,
            role: "assistant",
            content: streamedReply.trim(),
            is_visible: true,
            context_status: "active",
            generation_status: "stopped",
            ...(operation === "regenerate" ? { replaces_message_id: targetMessageId } : {}),
          }).select("id").single();
          if (partialInsertError) throw partialInsertError;
          partialMessage = data;
        }
        await supabase.from("chat_requests").update({
          status: "cancelled", partial_content: streamedReply.trim() || null, assistant_message_id: partialMessage?.id || null,
          completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_code: null,
        }).eq("id", trackedRequest.id).eq("user_id", req.user.id);
        if (wantsStream) {
          sendStreamEvent("cancelled", { requestStatus: "cancelled", reply: streamedReply.trim(), messageId: partialMessage?.id || null, sessionId: trackedRequest.session_id });
          streamClosed = true;
          return res.end();
        }
      } catch (partialError) {
        console.error("Partial reply save failed:", partialError);
      }
    }
    if (trackedRequest?.id) {
      try {
        await supabase.from("chat_requests").update({
          status: cancelled ? "cancelled" : "failed",
          error_code: error?.code ? String(error.code).slice(0, 120) : "chat_failed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", trackedRequest.id).eq("user_id", req.user.id);
      } catch {
        console.error("Chat request failure tracking failed");
      }
    }
    if (wantsStream) {
      if (!streamClosed) sendStreamEvent("error", { error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
      return res.end();
    }
    res.status(cancelled ? 409 : 500).json({ success: false, error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
  } finally {
    activeChatControllers.delete(clientRequestId);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
