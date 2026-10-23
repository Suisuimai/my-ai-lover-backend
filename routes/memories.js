const express = require("express");
const router = express.Router();
const { getOrCreateDefaultCharacter, getOwnedCharacter } = require("../services/data");
const { textUpdate } = require("../services/helpers");
const { supabase } = require("../services/db");
const { MEMORY_CATEGORIES, splitTriggers } = require("../core/memory");

router.get("/memories", async (req, res) => {
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

router.post("/memories", async (req, res) => {
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

router.patch("/memories/:memoryId", async (req, res) => {
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

router.delete("/memories/:memoryId", async (req, res) => {
  const { data, error } = await supabase.from("memories").update({
    status: "deleted", updated_at: new Date().toISOString(),
  }).eq("id", req.params.memoryId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Memory not found" });
  res.status(204).end();
});

module.exports = router;
