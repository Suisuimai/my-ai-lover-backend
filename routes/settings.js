const express = require("express");
const router = express.Router();
const { getSettings, toSettings } = require("../services/data");
const { getModelProvider, MODEL_PROVIDERS } = require("../services/model");
const { encryptSecret } = require("../services/encryption");
const { supabase } = require("../services/db");

router.get("/settings", async (req, res) => {
  try {
    res.json({ success: true, settings: toSettings(await getSettings(req.user.id)) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/settings", async (req, res) => {
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
  if (typeof req.body.timelineModel === "string" && req.body.timelineModel.trim()) {
    getModelProvider(req.body.timelineModel.trim());
    updates.timeline_model = req.body.timelineModel.trim();
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

router.get("/settings/credentials", async (req, res) => {
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

router.put("/settings/credentials/:provider", async (req, res) => {
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

router.delete("/settings/credentials/:provider", async (req, res) => {
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

module.exports = router;
