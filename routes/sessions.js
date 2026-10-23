const express = require("express");
const router = express.Router();
const { createSession, requireOwnedSession } = require("../services/data");
const { DEFAULT_SESSION_NAME, validUuid } = require("../services/helpers");
const { supabase } = require("../services/db");

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

router.get("/sessions/:sessionId/messages", sendMessages);
router.get("/messages/:sessionId", sendMessages);

router.get("/source-messages", async (req, res) => {
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

router.post("/messages/:messageId/select-variant", async (req, res) => {
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

module.exports = router;
