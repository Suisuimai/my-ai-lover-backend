const express = require("express");
const router = express.Router();
const { getOrCreateDefaultCharacter, getOwnedCharacter, requireOwnedSession } = require("../services/data");
const { textUpdate } = require("../services/helpers");
const { supabase } = require("../services/db");
const { FOLLOW_UP_KINDS, FOLLOW_UP_STATUSES } = require("../core/followup");
const { splitTriggers } = require("../core/memory");

router.get("/follow-ups", async (req, res) => {
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

router.post("/follow-ups", async (req, res) => {
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

router.patch("/follow-ups/:followUpId", async (req, res) => {
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

router.post("/follow-ups/confirm-create", async (req, res) => {
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

router.post("/follow-ups/:followUpId/confirm-status", async (req, res) => {
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

router.delete("/follow-ups/:followUpId", async (req, res) => {
  const { data, error } = await supabase.from("follow_ups").delete()
    .eq("id", req.params.followUpId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Follow-up not found" });
  res.status(204).end();
});

module.exports = router;
