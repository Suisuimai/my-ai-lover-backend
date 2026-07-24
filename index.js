const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

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

const allowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(",").map((origin) => origin.trim())
  : true;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

function toSettings(settings) {
  return {
    systemPrompt: settings.system_prompt,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.max_tokens,
    contextTokenThreshold: settings.context_token_threshold,
    recentMessageLimit: settings.recent_message_limit,
    summaryModel: settings.summary_model,
  };
}

function buildModelContext({ systemPrompt, memorySummary, recentMessages }) {
  return [
    // Layer 1: stable personality and behavior rules.
    { role: "system", content: systemPrompt },
    // Layer 2: compressed knowledge from earlier parts of this conversation.
    ...(memorySummary ? [{ role: "system", content: `Conversation memory summary:\n${memorySummary}` }] : []),
    // Layer 3: the immediate dialogue, oldest to newest (including the new user message).
    ...recentMessages.map(({ role, content }) => ({ role, content })),
  ];
}

function getModelProvider(model) {
  const provider = MODEL_PROVIDERS.find((item) => item.matches(model));
  if (!provider) throw new Error(`Unsupported model: ${model}`);

  const apiKey = provider.apiKey();
  if (!apiKey) throw new Error(`${provider.name} API key is not configured on the server`);
  return { ...provider, apiKey };
}

async function callModel({ model, messages, temperature, maxTokens }) {
  const provider = getModelProvider(model);
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

function estimateTokens(text) {
  // Conservative approximation for mixed Chinese and English text.
  return Math.ceil((text || "").length / 2);
}

function normalizeRecentMessageLimit(limit) {
  const safeLimit = Math.max(2, Number(limit) || DEFAULT_SETTINGS.recent_message_limit);
  return safeLimit % 2 === 0 ? safeLimit : safeLimit + 1;
}

async function maybeCompressMemory(sessionId, settings) {
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

async function getSettings() {
  const { data, error } = await supabase
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: createError } = await supabase
    .from("app_settings")
    .upsert({ id: 1, ...DEFAULT_SETTINGS })
    .select()
    .single();

  if (createError) throw createError;
  return created;
}

async function createSession(name = DEFAULT_SESSION_NAME) {
  const { data, error } = await supabase
    .from("sessions")
    .insert({ name })
    .select("id, name, created_at, updated_at")
    .single();

  if (error) throw error;
  return data;
}

async function touchSession(sessionId) {
  const { error } = await supabase
    .from("sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (error) throw error;
}

async function createTitle(model, message, reply) {
  const fallback = message.slice(0, 16);

  try {
    return (await callModel({
      model,
      temperature: 0.3,
      maxTokens: 20,
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

app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "AI Lover Backend is running" });
});

// Session management
app.get("/sessions", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, name, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json(data);
});

app.post("/sessions", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 48) : "";

  try {
    const session = await createSession(name || DEFAULT_SESSION_NAME);
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
    .select("id, name, created_at, updated_at")
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Session not found" });
  res.json({ success: true, session: data });
});

app.delete("/sessions/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;

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
async function readVisibleMessages(sessionId) {
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
    const messages = await readVisibleMessages(req.params.sessionId);
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

  const { data, error } = await supabase
    .from("messages")
    .insert({ session_id: req.params.sessionId, role, content: content.trim(), is_visible: true })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });

  try {
    await touchSession(req.params.sessionId);
  } catch (touchError) {
    console.error("Session timestamp update failed:", touchError);
  }

  res.status(201).json({ success: true, message: data });
});

// Settings
app.get("/settings", async (req, res) => {
  try {
    res.json({ success: true, settings: toSettings(await getSettings()) });
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

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, error: "No valid settings were provided" });
  }

  try {
    await getSettings();
    const { data, error } = await supabase
      .from("app_settings")
      .update(updates)
      .eq("id", 1)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, settings: toSettings(data) });
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
      const session = await createSession(DEFAULT_SESSION_NAME);
      sessionId = session.id;
      isNewSession = true;
    }

    const { error: userMessageError } = await supabase
      .from("messages")
      .insert({ session_id: sessionId, role: "user", content: message, is_visible: true });
    if (userMessageError) throw userMessageError;

    const settings = await getSettings();
    let memorySummary;
    try {
      memorySummary = await maybeCompressMemory(sessionId, settings);
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

    const context = buildModelContext({
      systemPrompt: settings.system_prompt,
      memorySummary,
      recentMessages: recentHistory.reverse(),
    });

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : settings.model;
    const reply = await callModel({
      model: requestedModel,
      temperature: settings.temperature,
      maxTokens: settings.max_tokens,
      messages: context,
    });

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("messages")
      .insert({ session_id: sessionId, role: "assistant", content: reply, is_visible: true })
      .select()
      .single();
    if (assistantMessageError) throw assistantMessageError;

    let title;
    if (isNewSession) {
      title = await createTitle(requestedModel, message, reply);
      const { error: titleError } = await supabase
        .from("sessions")
        .update({ name: title, updated_at: new Date().toISOString() })
        .eq("id", sessionId);
      if (titleError) console.error("Session title update failed:", titleError);
    } else {
      await touchSession(sessionId);
    }

    res.json({ success: true, sessionId, title, reply, messageId: assistantMessage.id });
  } catch (error) {
    console.error("Chat failed:", error);
    res.status(500).json({ success: false, error: error.message, reply: "Sorry, I could not reply just now." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
