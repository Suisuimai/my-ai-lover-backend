const { supabase } = require("./db");
const { DEFAULT_SESSION_NAME } = require("./helpers");
const {
  estimateTokens,
  normalizeRecentMessageLimit,
} = require("../core/context");
const {
  parseMemoryExtraction,
  rankMemories,
  splitTriggers,
} = require("../core/memory");
const { buildSemanticEventPrompt, parseSemanticEventDecision } = require("../core/eventInterpreter");
const { selectRelevantTimeline } = require("../core/timeline");

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
  const { callModel } = require("./model");
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
  const { callModel } = require("./model");
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
  const { callModel } = require("./model");
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

async function maybeCompressMemory(sessionId, settings, userId) {
  const { callModel } = require("./model");
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

module.exports = {
  DEFAULT_SETTINGS,
  toSettings,
  getSettings,
  getOrCreateDefaultCharacter,
  getOrCreateUserProfile,
  getOwnedCharacter,
  loadPromptDocuments,
  loadRelevantTimeline,
  loadWindowContinuity,
  createSession,
  touchSession,
  requireOwnedSession,
  createTitle,
  recallMemories,
  loadStatusFollowUps,
  interpretSemanticEvent,
  extractLongTermMemories,
  saveExplicitMemory,
  saveExplicitFollowUp,
  maybeCompressMemory,
};
