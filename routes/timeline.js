const express = require("express");
const crypto = require("crypto");
const { supabase } = require("../services/db");
const { textUpdate, limitedStrings, ownedMessageIds } = require("../services/helpers");
const { callModel, getModelTarget } = require("../services/model");
const { getSettings, getOwnedCharacter, getOrCreateDefaultCharacter, requireOwnedSession } = require("../services/data");
const { rebuildSharedLifeDays } = require("../services/diary");
const { cleanClaudeSay, normalizeClaudeExport, parseTimelineCandidates, segmentClaudeMessages } = require("../core/claudeImport");
const { normalizeEvidenceTerms } = require("../core/timeline");

const router = express.Router();

router.get("/timeline-imports", async (req, res) => {
  const { data, error } = await supabase.from("conversation_imports").select("*")
    .eq("user_id", req.user.id).neq("status", "deleted").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, imports: data || [] });
});

router.post("/timeline-imports", async (req, res) => {
  let createdImport;
  try {
    const character = req.body.characterId ? await getOwnedCharacter(req.body.characterId, req.user.id) : await getOrCreateDefaultCharacter(req.user.id);
    const messages = normalizeClaudeExport(req.body.exportData).map((message, index) => ({
      ...message, sourceMessageId: crypto.randomUUID(), sourcePosition: index + 1,
    }));
    if (messages.length > 10000) return res.status(400).json({ success: false, error: "An export can contain at most 10,000 messages" });
    const segments = segmentClaudeMessages(messages);
    const title = String(req.body.exportData?.metadata?.title || req.body.sourceFilename || "Claude import").slice(0, 160);
    const { data, error } = await supabase.from("conversation_imports").insert({
      user_id: req.user.id, character_id: character.id, title,
      source_filename: String(req.body.sourceFilename || "claude-export.json").slice(0, 255),
      source_metadata: req.body.exportData?.metadata || {}, message_count: messages.length,
      character_count: messages.reduce((sum, item) => sum + item.raw.length, 0), segment_count: segments.length,
    }).select().single();
    if (error) throw error;
    createdImport = data;
    const rows = segments.map((segment) => ({
      import_id: data.id, user_id: req.user.id, character_id: character.id, sequence: segment.sequence,
      started_at: segment.startedAt, ended_at: segment.endedAt, message_count: segment.messageCount,
      character_count: segment.charCount, raw_messages: segment.rawMessages, cleaned_transcript: segment.transcript,
    }));
    const { data: savedSegments, error: segmentError } = await supabase.from("imported_conversation_segments").insert(rows).select("id,sequence,started_at,ended_at,message_count,character_count,status");
    if (segmentError) throw segmentError;
    const segmentIds = new Map(savedSegments.map((segment) => [segment.sequence, segment.id]));
    const sourceRows = rows.flatMap((segment) => segment.raw_messages.map((source, index) => ({
      id: source.source_message_id,
      user_id: req.user.id,
      character_id: character.id,
      source_kind: "claude_import",
      revision_kind: "original",
      role: source.role,
      raw_content: source.content,
      occurred_at: source.time,
      import_id: data.id,
      imported_segment_id: segmentIds.get(segment.sequence),
      revision_number: 0,
      source_position: source.source_position,
      segment_message_index: index + 1,
      source_metadata: { source_filename: String(req.body.sourceFilename || "claude-export.json").slice(0, 255), segment_sequence: segment.sequence },
    })));
    const { error: sourceError } = await supabase.from("source_messages").insert(sourceRows);
    if (sourceError) throw sourceError;
    setImmediate(() => rebuildSharedLifeDays(req.user.id, character.id).catch((reason) => console.error("Imported shared-day refresh failed:", reason.message)));
    res.status(201).json({ success: true, import: data, segments: savedSegments });
  } catch (error) {
    if (createdImport?.id) await supabase.from("conversation_imports").delete().eq("id", createdImport.id).eq("user_id", req.user.id);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/timeline-imports/:importId/segments", async (req, res) => {
  const { data, error } = await supabase.from("imported_conversation_segments")
    .select("id,sequence,started_at,ended_at,message_count,character_count,status,timeline_candidates(id,status)")
    .eq("import_id", req.params.importId).eq("user_id", req.user.id).order("sequence");
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, segments: (data || []).map((segment) => ({
    ...segment,
    candidateCount: (segment.timeline_candidates || []).length,
    suggestedCount: (segment.timeline_candidates || []).filter((candidate) => candidate.status === "suggested").length,
    timeline_candidates: undefined,
  })) });
});

router.get("/timeline-segments/:segmentId", async (req, res) => {
  const { data, error } = await supabase.from("imported_conversation_segments").select("*")
    .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Imported segment not found" });
  res.json({ success: true, segment: data });
});

router.post("/timeline-segments/:segmentId/generate", async (req, res) => {
  try {
    const { data: segment, error } = await supabase.from("imported_conversation_segments").select("*")
      .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!segment) return res.status(404).json({ success: false, error: "Imported segment not found" });
    const settings = await getSettings(req.user.id);
    const model = settings.timeline_model || settings.summary_model;
    const sourceMessages = (segment.raw_messages || []).map((message) => ({
      role: message.role,
      content: cleanClaudeSay(message.role, message.content),
    }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");
    const raw = await callModel({
      purpose: "timeline_generation",
      model,
      userId: req.user.id,
      temperature: 0.1,
      maxTokens: 2600,
      responseFormat: "json_object",
      thinking: "disabled",
      messages: [
      { role: "system", content: [
        "You create documentary timeline candidates from an AI-companion conversation segment.",
        "Return JSON only: {\"candidates\":[{\"title\":\"\",\"body_markdown\":\"\",\"current_state\":\"\",\"index_summary\":\"\",\"evidence_message_numbers\":[1,2],\"evidence_terms\":[\"\"]}]}",
        "Create 0-4 candidates. Record only durable experiences, relationship developments, decisions, or meaningful current states.",
        "Do not turn roleplay scenery, speculation, model analysis, or ordinary affectionate filler into real-world facts.",
        "Every factual claim must be supported by evidence_message_numbers that refer to the numbered source messages. Never copy or rewrite evidence text yourself.",
        "current_state must describe how the matter stood at the END of this segment, not an earlier state.",
      ].join("\n") },
      { role: "user", content: `Segment time: ${segment.started_at} to ${segment.ended_at}\n\n${numberedTranscript}` },
      ],
    });
    const candidates = parseTimelineCandidates(raw, numberedTranscript, sourceMessages);
    await supabase.from("timeline_candidates").delete().eq("segment_id", segment.id).eq("user_id", req.user.id).eq("status", "suggested");
    const rows = candidates.map((candidate) => ({
      segment_id: segment.id, user_id: req.user.id, character_id: segment.character_id, model,
      title: candidate.title, body_markdown: candidate.bodyMarkdown, current_state: candidate.currentState,
      index_summary: candidate.indexSummary, evidence_quotes: candidate.evidenceQuotes,
      evidence_terms: normalizeEvidenceTerms(candidate.evidenceTerms, 12),
    }));
    const { data: saved, error: saveError } = rows.length ? await supabase.from("timeline_candidates").insert(rows).select("*") : { data: [], error: null };
    if (saveError) throw saveError;
    await supabase.from("imported_conversation_segments").update({ status: "generated" }).eq("id", segment.id).eq("user_id", req.user.id);
    res.json({ success: true, candidates: saved || [], candidateCount: (saved || []).length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/timeline-candidates", async (req, res) => {
  const { data, error } = await supabase.from("timeline_candidates").select("*")
    .eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, candidates: data || [] });
});

router.patch("/timeline-candidates/:candidateId", async (req, res) => {
  try {
    const { data: candidate, error } = await supabase.from("timeline_candidates").select("*, imported_conversation_segments(cleaned_transcript)")
      .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").maybeSingle();
    if (error) throw error;
    if (!candidate) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
    const updates = {};
    for (const [bodyKey, column, max] of [["title","title",160],["bodyMarkdown","body_markdown",20000],["currentState","current_state",3000],["indexSummary","index_summary",1200]]) {
      const value = textUpdate(req.body, bodyKey, max); if (value !== undefined) updates[column] = value;
    }
    if (Array.isArray(req.body.evidenceTerms) || typeof req.body.evidenceTerms === "string") updates.evidence_terms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
    if (Array.isArray(req.body.evidenceQuotes)) {
      const quotes = limitedStrings(req.body.evidenceQuotes, 6, 2000);
      if (!quotes.length || quotes.some((quote) => !candidate.imported_conversation_segments.cleaned_transcript.includes(quote))) {
        return res.status(400).json({ success: false, error: "Every evidence quote must exist exactly in the source segment" });
      }
      updates.evidence_quotes = quotes;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No candidate fields were provided" });
    if ([updates.title, updates.body_markdown, updates.current_state, updates.index_summary].some((value) => value === "")) return res.status(400).json({ success: false, error: "Candidate fields cannot be empty" });
    const { data: saved, error: saveError } = await supabase.from("timeline_candidates").update(updates)
      .eq("id", candidate.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    res.json({ success: true, candidate: saved });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.post("/timeline-candidates/:candidateId/confirm", async (req, res) => {
  try {
    const { data: candidate, error } = await supabase.from("timeline_candidates").select("*, imported_conversation_segments(ended_at)")
      .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").maybeSingle();
    if (error) throw error;
    if (!candidate) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
    const { data: entry, error: entryError } = await supabase.from("timeline_entries").insert({
      user_id: req.user.id, character_id: candidate.character_id, title: candidate.title,
      body_markdown: candidate.body_markdown, current_state: candidate.current_state,
      index_summary: candidate.index_summary, evidence_terms: candidate.evidence_terms,
      occurred_at: candidate.imported_conversation_segments.ended_at, confirmation_status: "confirmed", created_by: "ai",
    }).select().single();
    if (entryError) throw entryError;
    const { data: reviewed, error: reviewError } = await supabase.from("timeline_candidates").update({
      status: "confirmed", timeline_entry_id: entry.id, reviewed_at: new Date().toISOString(),
    }).eq("id", candidate.id).eq("user_id", req.user.id).select().single();
    if (reviewError) { await supabase.from("timeline_entries").delete().eq("id", entry.id).eq("user_id", req.user.id); throw reviewError; }
    res.json({ success: true, candidate: reviewed, entry });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.post("/timeline-candidates/:candidateId/reject", async (req, res) => {
  const { data, error } = await supabase.from("timeline_candidates").update({ status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", req.params.candidateId).eq("user_id", req.user.id).eq("status", "suggested").select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Suggested candidate not found" });
  res.json({ success: true, candidate: data });
});

router.get("/timeline", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("timeline_entries").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .neq("status", "deleted").order("occurred_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, entries: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/timeline", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const title = textUpdate(req.body, "title", 160);
    const bodyMarkdown = textUpdate(req.body, "bodyMarkdown", 20000);
    const currentState = textUpdate(req.body, "currentState", 3000);
    const indexSummary = textUpdate(req.body, "indexSummary", 1200);
    const evidenceTerms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();
    if (!title || !bodyMarkdown || !currentState || !indexSummary || !evidenceTerms.length
        || Number.isNaN(occurredAt.getTime())) {
      return res.status(400).json({ success: false, error: "Title, journal text, current state, index summary, evidence terms, and a valid time are required" });
    }
    let sourceSessionId = null;
    if (req.body.sourceSessionId) {
      const session = await requireOwnedSession(req.body.sourceSessionId, req.user.id);
      if (session.character_id !== character.id) return res.status(400).json({ success: false, error: "Session and timeline entry use different companions" });
      sourceSessionId = session.id;
    }
    const sourceMessageIds = await ownedMessageIds(req.body.sourceMessageIds, sourceSessionId, 20);
    const { data, error } = await supabase.from("timeline_entries").insert({
      user_id: req.user.id,
      character_id: character.id,
      source_session_id: sourceSessionId,
      title,
      body_markdown: bodyMarkdown,
      current_state: currentState,
      index_summary: indexSummary,
      evidence_terms: evidenceTerms,
      source_message_ids: sourceMessageIds,
      occurred_at: occurredAt.toISOString(),
      confirmation_status: req.body.confirmationStatus === "confirmed" ? "confirmed" : "auto",
      created_by: req.body.createdBy === "user" ? "user" : "ai",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, entry: data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.patch("/timeline/:entryId", async (req, res) => {
  const updates = {};
  for (const [bodyKey, column, max] of [
    ["title", "title", 160], ["bodyMarkdown", "body_markdown", 20000],
    ["currentState", "current_state", 3000], ["indexSummary", "index_summary", 1200],
  ]) {
    const value = textUpdate(req.body, bodyKey, max);
    if (value !== undefined) updates[column] = value;
  }
  if (Array.isArray(req.body.evidenceTerms) || typeof req.body.evidenceTerms === "string") {
    updates.evidence_terms = normalizeEvidenceTerms(req.body.evidenceTerms, 12);
  }
  if (["auto", "confirmed"].includes(req.body.confirmationStatus)) {
    updates.confirmation_status = req.body.confirmationStatus;
  }
  if (req.body.occurredAt !== undefined) {
    const occurredAt = new Date(req.body.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ success: false, error: "Invalid time" });
    updates.occurred_at = occurredAt.toISOString();
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: "No timeline fields were provided" });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("timeline_entries").update(updates)
    .eq("id", req.params.entryId).eq("user_id", req.user.id).neq("status", "deleted")
    .select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Timeline entry not found" });
  res.json({ success: true, entry: data });
});

router.post("/timeline/:entryId/retract", async (req, res) => {
  const quote = textUpdate(req.body, "quote", 2000);
  const reason = textUpdate(req.body, "reason", 2000);
  if (!quote || !reason) return res.status(400).json({ success: false, error: "An exact quote and reason are required" });
  try {
    const { data: entry, error: entryError } = await supabase.from("timeline_entries").select("*")
      .eq("id", req.params.entryId).eq("user_id", req.user.id).eq("status", "active").maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Active timeline entry not found" });
    if (!entry.body_markdown.includes(quote) && !entry.current_state.includes(quote)) {
      return res.status(400).json({ success: false, error: "The quote must appear exactly in the journal text or current state" });
    }
    let replacementEntryId = null;
    if (req.body.replacementEntryId) {
      const { data: replacement, error: replacementError } = await supabase.from("timeline_entries").select("id")
        .eq("id", req.body.replacementEntryId).eq("user_id", req.user.id)
        .eq("character_id", entry.character_id).eq("status", "active").maybeSingle();
      if (replacementError) throw replacementError;
      if (!replacement) return res.status(400).json({ success: false, error: "Replacement entry must be an active journal for the same companion" });
      replacementEntryId = replacement.id;
    }
    const { data: retraction, error: retractionError } = await supabase.from("timeline_retractions").insert({
      user_id: req.user.id,
      character_id: entry.character_id,
      timeline_entry_id: entry.id,
      replacement_entry_id: replacementEntryId,
      quote,
      reason,
    }).select().single();
    if (retractionError) throw retractionError;
    const { data: updated, error: updateError } = await supabase.from("timeline_entries").update({
      status: "retracted", updated_at: new Date().toISOString(),
    }).eq("id", entry.id).eq("user_id", req.user.id).select().single();
    if (updateError) {
      await supabase.from("timeline_retractions").delete().eq("id", retraction.id).eq("user_id", req.user.id);
      throw updateError;
    }
    res.json({ success: true, entry: updated, retraction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete("/timeline/:entryId", async (req, res) => {
  const { data, error } = await supabase.from("timeline_entries").update({
    status: "deleted", updated_at: new Date().toISOString(),
  }).eq("id", req.params.entryId).eq("user_id", req.user.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Timeline entry not found" });
  res.status(204).end();
});

module.exports = router;
