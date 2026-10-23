const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { getOwnedCharacter, getOrCreateDefaultCharacter, loadPromptDocuments, textUpdate } = require("../services/auth");
const {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_CONTENT,
  DOCUMENT_TYPES,
  LOAD_MODES,
  CONFIRMATION_STATUSES,
} = require("../core/promptDocuments");

router.get("/prompt-documents", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    res.json({ success: true, documents: await loadPromptDocuments(req.user.id, character.id) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/prompt-documents", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const existing = await loadPromptDocuments(req.user.id, character.id);
    if (existing.length >= MAX_DOCUMENTS) {
      return res.status(400).json({ success: false, error: `A companion can have at most ${MAX_DOCUMENTS} prompt documents` });
    }
    const name = textUpdate(req.body, "name", 120);
    const content = textUpdate(req.body, "content", MAX_DOCUMENT_CONTENT);
    if (!name || !content) return res.status(400).json({ success: false, error: "Document name and Markdown content are required" });
    const documentType = DOCUMENT_TYPES.has(req.body.documentType) ? req.body.documentType : "topic";
    const loadMode = LOAD_MODES.has(req.body.loadMode) ? req.body.loadMode : "always";
    const confirmationStatus = CONFIRMATION_STATUSES.has(req.body.confirmationStatus)
      ? req.body.confirmationStatus : "confirmed";
    const nextOrder = existing.reduce((maximum, item) => Math.max(maximum, item.sort_order), -1) + 1;
    const { data, error } = await supabase.from("prompt_documents").insert({
      user_id: req.user.id,
      character_id: character.id,
      name,
      content,
      sort_order: nextOrder,
      is_enabled: loadMode !== "archive" && req.body.isEnabled !== false,
      document_type: documentType,
      load_mode: loadMode,
      confirmation_status: confirmationStatus,
      created_by: req.body.createdBy === "ai" ? "ai" : "user",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, document: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.patch("/prompt-documents/:documentId", async (req, res) => {
  const updates = {};
  const name = textUpdate(req.body, "name", 120);
  const content = textUpdate(req.body, "content", MAX_DOCUMENT_CONTENT);
  if (name !== undefined) updates.name = name;
  if (content !== undefined) updates.content = content;
  if (DOCUMENT_TYPES.has(req.body.documentType)) updates.document_type = req.body.documentType;
  if (LOAD_MODES.has(req.body.loadMode)) {
    updates.load_mode = req.body.loadMode;
    updates.is_enabled = req.body.loadMode !== "archive";
  } else if (typeof req.body.isEnabled === "boolean") {
    updates.is_enabled = req.body.isEnabled;
    updates.load_mode = req.body.isEnabled ? "always" : "archive";
  }
  if (CONFIRMATION_STATUSES.has(req.body.confirmationStatus)) {
    updates.confirmation_status = req.body.confirmationStatus;
  }
  if (updates.name === "" || updates.content === "") {
    return res.status(400).json({ success: false, error: "Document name and Markdown content cannot be empty" });
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No document fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("prompt_documents").update(updates)
    .eq("id", req.params.documentId).eq("user_id", req.user.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Prompt document not found" });
  res.json({ success: true, document: data });
});

router.put("/prompt-documents/order", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const ids = Array.isArray(req.body.documentIds) ? req.body.documentIds : [];
    const documents = await loadPromptDocuments(req.user.id, character.id);
    if (ids.length !== documents.length || new Set(ids).size !== ids.length
        || documents.some((document) => !ids.includes(document.id))) {
      return res.status(400).json({ success: false, error: "Document order must contain every document exactly once" });
    }
    for (const [sortOrder, id] of ids.entries()) {
      const { error } = await supabase.from("prompt_documents").update({
        sort_order: sortOrder, updated_at: new Date().toISOString(),
      }).eq("id", id).eq("user_id", req.user.id).eq("character_id", character.id);
      if (error) throw error;
    }
    res.json({ success: true, documents: await loadPromptDocuments(req.user.id, character.id) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.delete("/prompt-documents/:documentId", async (req, res) => {
  const { data, error } = await supabase.from("prompt_documents").delete()
    .eq("id", req.params.documentId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Prompt document not found" });
  res.status(204).end();
});

router.get("/prompt-documents/:documentId/versions", async (req, res) => {
  const { data: document, error: documentError } = await supabase.from("prompt_documents").select("id")
    .eq("id", req.params.documentId).eq("user_id", req.user.id).maybeSingle();
  if (documentError) return res.status(500).json({ success: false, error: documentError.message });
  if (!document) return res.status(404).json({ success: false, error: "Prompt document not found" });
  const { data, error } = await supabase.from("prompt_document_versions").select("*")
    .eq("document_id", document.id).eq("user_id", req.user.id)
    .order("version", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, versions: data || [] });
});

module.exports = router;
