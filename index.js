const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  buildModelContext,
  estimateTokens,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
} = require("./core/context");
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
const { formatWindowContinuity } = require("./core/handoff");
const { normalizeClaudeExport, parseTimelineCandidates, segmentClaudeMessages } = require("./core/claudeImport");
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

async function callModel({ model, messages, temperature, maxTokens, userId }) {
  const provider = getModelProvider(model);
  if (userId) {
    const { data: credential } = await supabase.from("model_credentials").select("encrypted_key").eq("user_id", userId).eq("provider", provider.name).maybeSingle();
    if (credential?.encrypted_key) provider.apiKey = decryptSecret(credential.encrypted_key);
  }
  if (!provider.apiKey) throw new Error(`${provider.name} API key is not configured. Add it in Settings.`);
  let response;

  if (provider.type === "openai-compatible") {
    response = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `${provider.name} request failed`);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`${provider.name} returned an empty reply`);
    return text;
  }

  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const conversation = messages
    .filter((message) => message.role !== "system")
    .map(({ role, content }) => ({ role, content }));

  response = await fetch(provider.endpoint, {
    method: "POST",
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
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Anthropic request failed");
  const text = data.content?.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  if (!text) throw new Error("Anthropic returned an empty reply");
  return text;
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

async function loadLatestWindowContinuity(userId, characterId) {
  const { data: handoff, error } = await supabase.from("session_handoffs").select("*")
    .eq("user_id", userId).eq("character_id", characterId)
    .in("status", ["auto", "confirmed"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
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
  const { data, error } = await supabase
    .from("sessions")
    .insert({ name, user_id: userId, character_id: character.id })
    .select("id, name, character_id, created_at, updated_at")
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
  const { data, error } = await supabase.from("sessions").select("id, character_id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) { const missing = new Error("Session not found"); missing.status = 404; throw missing; }
  return data;
}

async function createTitle(model, message, reply, userId) {
  const fallback = message.slice(0, 16);

  try {
    return (await callModel({
      model,
      temperature: 0.3,
      maxTokens: 20,
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
    model: settings.summary_model,
    temperature: 0,
    maxTokens: 450,
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
    model: settings.summary_model,
    temperature: 0.1,
    maxTokens: 350,
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
    const messages = normalizeClaudeExport(req.body.exportData);
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
    res.status(201).json({ success: true, import: data, segments: savedSegments });
  } catch (error) {
    if (createdImport?.id) await supabase.from("conversation_imports").delete().eq("id", createdImport.id).eq("user_id", req.user.id);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get("/timeline-imports/:importId/segments", async (req, res) => {
  const { data, error } = await supabase.from("imported_conversation_segments")
    .select("id,sequence,started_at,ended_at,message_count,character_count,status")
    .eq("import_id", req.params.importId).eq("user_id", req.user.id).order("sequence");
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, segments: data || [] });
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
    const raw = await callModel({ model, userId: req.user.id, temperature: 0.1, maxTokens: 1800, messages: [
      { role: "system", content: [
        "You create documentary timeline candidates from an AI-companion conversation segment.",
        "Return JSON only: {\"candidates\":[{\"title\":\"\",\"body_markdown\":\"\",\"current_state\":\"\",\"index_summary\":\"\",\"evidence_quotes\":[\"exact source quote\"],\"evidence_terms\":[\"\"]}]}",
        "Create 0-4 candidates. Record only durable experiences, relationship developments, decisions, or meaningful current states.",
        "Do not turn roleplay scenery, speculation, model analysis, or ordinary affectionate filler into real-world facts.",
        "Every factual claim must be supported by exact evidence quotes copied from the source. State uncertainty explicitly.",
        "current_state must describe how the matter stood at the END of this segment, not an earlier state.",
      ].join("\n") },
      { role: "user", content: `Segment time: ${segment.started_at} to ${segment.ended_at}\n\n${segment.cleaned_transcript}` },
    ] });
    const candidates = parseTimelineCandidates(raw, segment.cleaned_transcript);
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
    res.json({ success: true, candidates: saved || [] });
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
        .eq("session_id", sourceSessionId).eq("is_visible", true)
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
    .select("id, session_id, role, content, is_visible, created_at")
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

app.post("/sessions/:sessionId/messages", async (req, res) => {
  const { role, content } = req.body;
  if (!["user", "assistant"].includes(role) || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ success: false, error: "role and content are required" });
  }

  try { await requireOwnedSession(req.params.sessionId, req.user.id); } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  const { data, error } = await supabase
    .from("messages")
    .insert({ session_id: req.params.sessionId, role, content: content.trim(), is_visible: true })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });

  try {
    await touchSession(req.params.sessionId, req.user.id);
  } catch (touchError) {
    console.error("Session timestamp update failed:", touchError);
  }

  res.status(201).json({ success: true, message: data });
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

// Core chat: persist user message, assemble the three-layer context, call model, persist assistant reply.
app.post("/chat", async (req, res) => {
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ success: false, error: "A message is required" });

  try {
    let sessionId = req.body.sessionId;
    let isNewSession = false;

    if (!sessionId) {
      const session = await createSession(req.user.id, DEFAULT_SESSION_NAME, req.body.characterId);
      sessionId = session.id;
      req.sessionRecord = session;
      isNewSession = true;
    }
    else {
      req.sessionRecord = await requireOwnedSession(sessionId, req.user.id);
    }

    const { error: userMessageError } = await supabase
      .from("messages")
      .insert({ session_id: sessionId, role: "user", content: message, is_visible: true });
    if (userMessageError) throw userMessageError;

    const settings = await getSettings(req.user.id);
    const character = req.sessionRecord.character_id
      ? await getOwnedCharacter(req.sessionRecord.character_id, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const userProfile = await getOrCreateUserProfile(req.user.id);
    const promptDocuments = await loadPromptDocuments(req.user.id, character.id);
    let relevantMemories = [];
    try {
      relevantMemories = await recallMemories(req.user.id, character.id, message);
    } catch (recallError) {
      console.error("Long-term memory recall failed:", recallError);
    }
    let statusFollowUps = [];
    let relevantFollowUps = [];
    try {
      statusFollowUps = await loadStatusFollowUps(req.user.id, character.id);
      const conversationalFollowUps = statusFollowUps.filter((item) => ["active", "waiting"].includes(item.status));
      relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    } catch (followUpError) {
      console.error("Follow-up recall failed:", followUpError);
    }
    let memorySummary;
    try {
      memorySummary = await maybeCompressMemory(sessionId, settings, req.user.id);
    } catch (compressionError) {
      // A temporary compression failure must not prevent the companion from replying.
      console.error("Memory compression failed:", compressionError);
      const { data: existingMemory, error: memoryError } = await supabase
        .from("session_memories")
        .select("summary")
        .eq("session_id", sessionId)
        .maybeSingle();
      if (memoryError) throw memoryError;
      memorySummary = existingMemory?.summary;
    }

    const { data: recentHistory, error: historyError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .eq("is_visible", true)
      .order("created_at", { ascending: false })
      .limit(normalizeRecentMessageLimit(settings.recent_message_limit));
    if (historyError) throw historyError;

    const conversationalFollowUps = statusFollowUps.filter((item) => ["active", "waiting"].includes(item.status));
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, recentHistory, 1);
    }
    const statusRelevantFollowUps = selectContextualFollowUps(statusFollowUps, message, recentHistory, 1);
    const historyChronological = [...recentHistory].reverse();
    const semanticEventPromise = interpretSemanticEvent({
      userId: req.user.id,
      settings,
      message,
      recentMessages: recentHistory,
      followUps: statusFollowUps,
    }).catch((semanticError) => {
      console.error("Semantic event interpretation failed:", semanticError);
      return null;
    });

    const context = buildModelContext({
      systemPrompt: settings.system_prompt
        ? `User-configured system instructions:\n${settings.system_prompt}`
        : "",
      promptDocuments: formatPromptDocuments(promptDocuments),
      characterProfile: formatCharacterProfile(character),
      userProfile: formatUserProfile(userProfile),
      followUps: formatFollowUps(relevantFollowUps),
      longTermMemories: formatLongTermMemories(relevantMemories),
      memorySummary,
      recentMessages: historyChronological,
    });

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : settings.model;
    const [reply, semanticEventSuggestion] = await Promise.all([
      callModel({
        model: requestedModel,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        messages: context,
        userId: req.user.id,
      }),
      semanticEventPromise,
    ]);

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("messages")
      .insert({ session_id: sessionId, role: "assistant", content: reply, is_visible: true })
      .select()
      .single();
    if (assistantMessageError) throw assistantMessageError;

    let title;
    if (isNewSession) {
      title = await createTitle(requestedModel, message, reply, req.user.id);
      const { error: titleError } = await supabase
        .from("sessions")
        .update({ name: title, updated_at: new Date().toISOString() })
        .eq("id", sessionId);
      if (titleError) console.error("Session title update failed:", titleError);
    } else {
      await touchSession(sessionId, req.user.id);
    }

    const ruleBasedSuggestion = suggestFollowUpStatus(statusRelevantFollowUps, message);
    const followUpStatusSuggestion = semanticEventSuggestion || (ruleBasedSuggestion
      ? { action: "update", ...ruleBasedSuggestion }
      : null);
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

    res.json({
      success: true,
      sessionId,
      title,
      reply,
      messageId: assistantMessage.id,
      memoryCapture: explicitMemory ? (capturedMemoryId ? "saved" : "failed") : "automatic_pending",
      followUpCapture,
      followUpStatusSuggestion,
    });
    if (!explicitMemory && (!followUpStatusSuggestion || followUpStatusSuggestion.suggestedStatus === "completed")) {
      extractLongTermMemories({
        userId: req.user.id,
        character,
        userProfile,
        sessionId,
        message,
        reply,
        settings,
      }).catch((memoryError) => console.error("Long-term memory extraction failed:", memoryError));
    }
  } catch (error) {
    console.error("Chat failed:", error);
    res.status(500).json({ success: false, error: error.message, reply: "Sorry, I could not reply just now." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
