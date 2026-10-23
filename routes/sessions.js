const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { requireOwnedSession, createSession, DEFAULT_SESSION_NAME } = require("../services/auth");

async function readVisibleMessages(sessionId, userId) {
  await requireOwnedSession(sessionId, userId);
  const { data, error } = await supabase
    .from("messages")
    .select("id, session_id, role, content, is_visible, context_status, replaces_message_id, generation_status, finish_reason, continues_message_id, recall_info, created_at")
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

// Session management
router.get("/sessions", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, name, character_id, created_at, updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json(data);
});

router.post("/sessions", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 48) : "";

  try {
    const session = await createSession(req.user.id, name || DEFAULT_SESSION_NAME, req.body.characterId);
    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/sessions/:sessionId", async (req, res) => {
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

router.delete("/sessions/:sessionId", async (req, res) => {
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
router.get("/sessions/:sessionId/messages", sendMessages);
router.get("/messages/:sessionId", sendMessages);

module.exports = router;
