const dns = require("node:dns").promises;
const { createChatTiming } = require("../core/chatTiming");
const {
  selectConversationWindow,
} = require("../core/context");
const {
  FEATURE_PURPOSES,
  connectionKind,
  embeddingEndpoint,
  isPrivateIp,
  modelEndpoint,
  normalizeBaseUrl,
} = require("../core/apiConnections");
const { normalizeModelUsage } = require("../core/apiUsage");
const { groupSourceMessagesBySharedDay } = require("../core/sharedDays");
const { buildRetrievalWindows } = require("../core/sourceRecall");
const crypto = require("crypto");

const { supabase } = require("./db");
const { encryptSecret, decryptSecret } = require("./encryption");

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

async function requireUser(req, res, next) {
  if (req.path === "/chat" && req.method === "POST") req.chatTiming = createChatTiming();
  const endAuth = req.chatTiming?.start("authentication");
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired session" });
  endAuth?.(true);
  req.user = data.user;
  next();
}

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

async function readSourceMessagesByIds(userId, characterId, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const chunkSize = 200;
  const chunks = [];
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    chunks.push(uniqueIds.slice(index, index + chunkSize));
  }
  const batches = await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await supabase.from("source_messages")
      .select("id,role,raw_content,occurred_at,source_metadata")
      .eq("user_id", userId).eq("character_id", characterId).in("id", chunk);
    if (error) throw error;
    return data || [];
  }));
  return batches.flat();
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

function textUpdate(body, key, maxLength = 4000) {
  return typeof body[key] === "string" ? body[key].trim().slice(0, maxLength) : undefined;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_SESSION_NAME,
  MODEL_PROVIDERS,
  getModelProvider,
  requireUser,
  toSettings,
  getModelTarget,
  getEmbeddingTarget,
  callEmbeddings,
  validatePublicConnectionUrl,
  recordModelUsage,
  getSettings,
  getOrCreateDefaultCharacter,
  getOrCreateUserProfile,
  getOwnedCharacter,
  loadPromptDocuments,
  loadWindowContinuity,
  createSession,
  touchSession,
  requireOwnedSession,
  latestSharedDayVersions,
  readAllOwnedSourceMessages,
  readSourceMessagesByIds,
  sourceIndexStatus,
  buildSourceIndexBatch,
  textUpdate,
};
