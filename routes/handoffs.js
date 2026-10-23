const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { getOwnedCharacter, getOrCreateDefaultCharacter, requireOwnedSession, getSettings, textUpdate } = require("../services/auth");
const { callModel } = require("../services/model");
const { buildHandoffPrompt, parseHandoffCandidate } = require("../core/handoff");

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

router.get("/handoffs", async (req, res) => {
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

router.post("/handoffs/generate", async (req, res) => {
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

router.post("/handoffs", async (req, res) => {
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

router.patch("/handoffs/:handoffId", async (req, res) => {
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

module.exports = router;
