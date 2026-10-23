const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { encryptSecret, decryptSecret } = require("../services/encryption");
const { validatePublicConnectionUrl, textUpdate } = require("../services/auth");
const {
  FEATURE_DEFINITIONS,
  API_FORMATS,
  connectionKind,
  modelCatalogEndpoint,
  normalizeModelCatalog,
  safeConnectionView,
} = require("../core/apiConnections");

const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const modelCatalogCache = new Map();

router.get("/api-feature-definitions", (req, res) => {
  res.json({ success: true, features: FEATURE_DEFINITIONS.filter((feature) => !feature.hidden) });
});

router.get("/api-connections", async (req, res) => {
  try {
    const { data, error } = await supabase.from("api_connections").select("*")
      .eq("user_id", req.user.id).order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ success: true, connections: (data || []).map(safeConnectionView) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/api-connections/:connectionId/models", async (req, res) => {
  try {
    const { data: connection, error } = await supabase.from("api_connections").select("*")
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!connection) return res.status(404).json({ success: false, error: "Connection not found" });
    if (!connection.enabled) return res.status(400).json({ success: false, error: "Enable this connection before loading models" });

    const cached = modelCatalogCache.get(connection.id);
    if (cached && Date.now() - cached.loadedAt < MODEL_CATALOG_TTL_MS) {
      return res.json({ success: true, models: cached.models, cached: true, loadedAt: new Date(cached.loadedAt).toISOString() });
    }

    const endpoint = modelCatalogEndpoint(connection.base_url, connection.api_format);
    await validatePublicConnectionUrl(endpoint);
    const headers = connection.api_format === "anthropic"
      ? { "x-api-key": decryptSecret(connection.encrypted_key), "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${decryptSecret(connection.encrypted_key)}` };
    const response = await fetch(endpoint, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamMessage = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`Model list request failed: ${upstreamMessage}`);
    }
    const models = normalizeModelCatalog(payload);
    if (!models.length) throw new Error("This connection returned no usable model list; you can still enter a model ID manually");
    const loadedAt = Date.now();
    modelCatalogCache.set(connection.id, { models, loadedAt });
    res.json({ success: true, models, cached: false, loadedAt: new Date(loadedAt).toISOString() });
  } catch (error) {
    const message = error.name === "TimeoutError" ? "Loading models timed out; check the connection or enter a model ID manually" : error.message;
    res.status(502).json({ success: false, error: message });
  }
});

router.post("/api-connections", async (req, res) => {
  const label = textUpdate(req.body, "label", 80);
  const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  const apiFormat = typeof req.body.apiFormat === "string" ? req.body.apiFormat : "";
  if (!label || !apiKey || !API_FORMATS.has(apiFormat)) {
    return res.status(400).json({ success: false, error: "Name, API key, and a supported API format are required" });
  }
  try {
    const baseUrl = await validatePublicConnectionUrl(req.body.baseUrl);
    const { data, error } = await supabase.from("api_connections").insert({
      user_id: req.user.id,
      label,
      base_url: baseUrl,
      encrypted_key: encryptSecret(apiKey),
      api_format: apiFormat,
      notes: textUpdate(req.body, "notes", 1000) || "",
      enabled: req.body.enabled !== false,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, connection: safeConnectionView(data) });
  } catch (error) {
    const status = error.code === "23505" ? 409 : (/^Connection URL/.test(error.message) ? 400 : 500);
    res.status(status).json({ success: false, error: status === 409 ? "A connection with this name already exists" : error.message });
  }
});

router.patch("/api-connections/:connectionId", async (req, res) => {
  try {
    const { data: current, error: currentError } = await supabase.from("api_connections").select("*")
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ success: false, error: "Connection not found" });

    const updates = { updated_at: new Date().toISOString() };
    const label = textUpdate(req.body, "label", 80);
    const notes = textUpdate(req.body, "notes", 1000);
    if (label !== undefined) {
      if (!label) return res.status(400).json({ success: false, error: "Connection name cannot be empty" });
      updates.label = label;
    }
    if (notes !== undefined) updates.notes = notes;
    if (typeof req.body.enabled === "boolean") updates.enabled = req.body.enabled;
    if (typeof req.body.apiFormat === "string") {
      if (!API_FORMATS.has(req.body.apiFormat)) return res.status(400).json({ success: false, error: "Unsupported API format" });
      updates.api_format = req.body.apiFormat;
    }
    if (req.body.baseUrl !== undefined) updates.base_url = await validatePublicConnectionUrl(req.body.baseUrl);
    if (req.body.apiKey !== undefined) {
      const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
      if (!apiKey) return res.status(400).json({ success: false, error: "API key cannot be empty" });
      updates.encrypted_key = encryptSecret(apiKey);
    }

    const { data, error } = await supabase.from("api_connections").update(updates)
      .eq("id", current.id).eq("user_id", req.user.id).select().single();
    if (error) throw error;
    res.json({ success: true, connection: safeConnectionView(data) });
  } catch (error) {
    const status = error.code === "23505" ? 409 : (/^Connection URL/.test(error.message) ? 400 : 500);
    res.status(status).json({ success: false, error: status === 409 ? "A connection with this name already exists" : error.message });
  }
});

router.delete("/api-connections/:connectionId", async (req, res) => {
  try {
    const { count, error: routeError } = await supabase.from("api_feature_routes")
      .select("purpose", { count: "exact", head: true })
      .eq("user_id", req.user.id).eq("connection_id", req.params.connectionId);
    if (routeError) throw routeError;
    if (count) return res.status(409).json({ success: false, error: "Move assigned features before deleting this connection" });
    const { data, error } = await supabase.from("api_connections").delete()
      .eq("id", req.params.connectionId).eq("user_id", req.user.id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: "Connection not found" });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
