const express = require("express");
const router = express.Router();
const { getOrCreateUserProfile } = require("../services/data");
const { textUpdate } = require("../services/helpers");
const { supabase } = require("../services/db");

router.get("/profile", async (req, res) => {
  try {
    res.json({ success: true, profile: await getOrCreateUserProfile(req.user.id) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/profile", async (req, res) => {
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

module.exports = router;
