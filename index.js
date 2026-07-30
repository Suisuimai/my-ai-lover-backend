const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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
app.use(express.json());

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

function estimateTokens(text) {
  // Conservative approximation for mixed Chinese and English text.
  return Math.ceil((text || "").length / 2);
}

function normalizeRecentMessageLimit(limit) {
  const safeLimit = Math.max(2, Number(limit) || DEFAULT_SETTINGS.recent_message_limit);
  return safeLimit % 2 === 0 ? safeLimit : safeLimit + 1;
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

async function createSession(userId, name = DEFAULT_SESSION_NAME) {
  const { data, error } = await supabase
    .from("sessions")
    .insert({ name, user_id: userId })
    .select("id, name, created_at, updated_at")
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
  const { data, error } = await supabase.from("sessions").select("id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) { const missing = new Error("Session not found"); missing.status = 404; throw missing; }
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

app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "AI Lover Backend is running" });
});

// Session management
app.get("/sessions", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, name, created_at, updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json(data);
});

app.post("/sessions", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 48) : "";

  try {
    const session = await createSession(req.user.id, name || DEFAULT_SESSION_NAME);
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
    .select("id, name, created_at, updated_at")
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
      const session = await createSession(req.user.id, DEFAULT_SESSION_NAME);
      sessionId = session.id;
      isNewSession = true;
    }
    else {
      await requireOwnedSession(sessionId, req.user.id);
    }

    const { error: userMessageError } = await supabase
      .from("messages")
      .insert({ session_id: sessionId, role: "user", content: message, is_visible: true });
    if (userMessageError) throw userMessageError;

    const settings = await getSettings(req.user.id);
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
      userId: req.user.id,
    });

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

    res.json({ success: true, sessionId, title, reply, messageId: assistantMessage.id });
  } catch (error) {
    console.error("Chat failed:", error);
    res.status(500).json({ success: false, error: error.message, reply: "Sorry, I could not reply just now." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
