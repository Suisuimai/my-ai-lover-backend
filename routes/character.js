const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { getOrCreateDefaultCharacter, getOwnedCharacter, textUpdate } = require("../services/auth");

router.get("/character", async (req, res) => {
  try {
    res.json({ success: true, character: await getOrCreateDefaultCharacter(req.user.id) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/character", async (req, res) => {
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

module.exports = router;
