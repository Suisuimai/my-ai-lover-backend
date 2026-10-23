const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabase } = require("../services/db");
const { getOwnedCharacter, getOrCreateDefaultCharacter, readAllOwnedSourceMessages, latestSharedDayVersions } = require("../services/auth");
const { rebuildSharedLifeDays, startDiaryJob, startDiaryJobsSequentially, createDiaryJobForLatestVersion } = require("../services/data");
const { sharedDayVersionView } = require("../core/sharedDays");
const { cleanText, applyDiaryReview, reviewEventForAction } = require("../core/diaryReview");

router.get("/diary/shared-days", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data: days, error } = await supabase.from("shared_life_days").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("day_key", { ascending: false }).limit(120);
    if (error) throw error;
    const versions = await latestSharedDayVersions((days || []).map((day) => day.id), req.user.id);
    res.json({ success: true, days: (days || []).map((day) => ({
      ...day,
      latestVersion: sharedDayVersionView(versions.get(day.id)),
    })) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/diary/shared-days/rebuild", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    res.json({success:true,...await rebuildSharedLifeDays(req.user.id,character.id)});
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/diary/shared-days/:sharedDayId/seal", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
      .eq("id", req.params.sharedDayId).eq("user_id", req.user.id).eq("character_id", character.id).maybeSingle();
    if (dayError) throw dayError;
    if (!day) return res.status(404).json({ success: false, error: "Shared life day not found" });
    const { data: previous, error: previousError } = await supabase.from("shared_life_day_versions").select("*")
      .eq("shared_day_id", day.id).eq("user_id", req.user.id)
      .order("revision_number", { ascending: false }).limit(1).maybeSingle();
    if (previousError) throw previousError;
    if (!previous) return res.status(409).json({ success: false, error: "This shared day has no source messages" });
    if (previous.boundary_state === "sealed") return res.json({ success: true, created: false, version: previous });
    const { data: version, error: insertError } = await supabase.from("shared_life_day_versions").insert({
      shared_day_id: day.id, user_id: req.user.id, character_id: character.id,
      revision_number: previous.revision_number + 1,
      started_at: previous.started_at, ended_at: previous.ended_at,
      source_message_ids: previous.source_message_ids,
      first_source_message_id: previous.first_source_message_id,
      last_source_message_id: previous.last_source_message_id,
      morning_marker_source_id: previous.morning_marker_source_id,
      night_marker_source_id: previous.night_marker_source_id,
      boundary_state: "sealed", boundary_reason: "manual_end", supersedes_version_id: previous.id,
    }).select().single();
    if (insertError) throw insertError;
    res.status(201).json({ success: true, created: true, version });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/diary/backfill-sample", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const requestedCount = Math.min(5, Math.max(3, Number(req.body.count) || 3));
    const { data: days, error: dayError } = await supabase.from("shared_life_days").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("day_key", { ascending: false }).limit(120);
    if (dayError) throw dayError;
    const versions = await latestSharedDayVersions((days || []).map((day) => day.id), req.user.id);
    const [{ data: entries, error: entryError }, { data: jobs, error: jobError }] = await Promise.all([
      supabase.from("diary_entries").select("shared_day_id").eq("user_id", req.user.id).eq("character_id", character.id),
      supabase.from("diary_generation_jobs").select("shared_day_id").eq("user_id", req.user.id).eq("character_id", character.id),
    ]);
    if (entryError || jobError) throw entryError || jobError;
    const used = new Set([...(entries || []).map((item) => item.shared_day_id), ...(jobs || []).map((item) => item.shared_day_id)]);
    const candidates = (days || []).map((day) => ({ day, version: versions.get(day.id) }))
      .filter(({ day, version }) => version?.boundary_state === "sealed" && !used.has(day.id));
    const chosen = [];
    const choose = (candidate) => { if (candidate && !chosen.some((item) => item.day.id === candidate.day.id)) chosen.push(candidate); };
    choose(candidates[0]);
    choose([...candidates].sort((left, right) => right.version.source_message_ids.length - left.version.source_message_ids.length)[0]);
    const bySize = [...candidates].sort((left, right) => left.version.source_message_ids.length - right.version.source_message_ids.length);
    choose(bySize[Math.floor(bySize.length / 2)]);
    choose(candidates.find(({ version }) => version.night_marker_source_id));
    choose(candidates.at(-1));
    for (const candidate of candidates) {
      if (chosen.length >= requestedCount) break;
      choose(candidate);
    }
    const selected = chosen.slice(0, requestedCount);
    const createdJobs = [];
    for (const { day } of selected) {
      const result = await createDiaryJobForLatestVersion({ userId: req.user.id, characterId: character.id, sharedDayId: day.id });
      if (result.created) createdJobs.push(result.job);
    }
    startDiaryJobsSequentially(createdJobs.map((job) => job.id));
    res.status(202).json({
      success: true,
      selectedDays: selected.map(({ day, version }) => ({ id: day.id, dayKey: day.day_key, messageCount: version.source_message_ids.length })),
      jobs: createdJobs,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/diary/shared-days/:sharedDayId/generate", async (req, res) => {
  try {
    const character = req.body.characterId
      ? await getOwnedCharacter(req.body.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const result = await createDiaryJobForLatestVersion({
      userId: req.user.id, characterId: character.id, sharedDayId: req.params.sharedDayId,
      retry: req.body.retry === true,
    });
    if (result.created) startDiaryJob(result.job.id);
    res.status(result.created ? 202 : 200).json({ success: true, created: result.created, job: result.job });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/diary/entries", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_entries")
      .select("*,shared_life_days(day_key)").eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: false }).limit(120);
    if (error) throw error;
    res.json({ success: true, entries: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/diary/entries/:entryId/sources", async (req, res) => {
  try {
    const { data: entry, error: entryError } = await supabase.from("diary_entries")
      .select("id,character_id,source_message_ids").eq("id", req.params.entryId).eq("user_id", req.user.id).maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Diary entry not found" });
    const byId = new Map((await readAllOwnedSourceMessages(req.user.id, entry.character_id)).map((message) => [message.id, message]));
    const messages = entry.source_message_ids.map((id) => byId.get(id)).filter(Boolean).map((message) => ({
      id: message.id, role: message.role, content: message.raw_content,
      occurredAt: message.source_metadata?.original_message_created_at || message.occurred_at,
    }));
    res.json({ success: true, messages, partial: messages.length !== entry.source_message_ids.length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/diary/review-events", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_review_events").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: true }).limit(1000);
    if (error) throw error;
    res.json({ success: true, events: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/diary/entries/:entryId/review", async (req, res) => {
  try {
    const { data: entry, error: entryError } = await supabase.from("diary_entries").select("*")
      .eq("id", req.params.entryId).eq("user_id", req.user.id).maybeSingle();
    if (entryError) throw entryError;
    if (!entry) return res.status(404).json({ success: false, error: "Diary entry not found" });
    const { data: latest, error: latestError } = await supabase.from("diary_entries").select("id")
      .eq("shared_day_id", entry.shared_day_id).eq("user_id", req.user.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (latestError) throw latestError;
    if (latest?.id !== entry.id) return res.status(409).json({ success: false, error: "This diary has a newer version; refresh before reviewing" });

    const action = String(req.body.action || "");
    const issueIndex = Number.isInteger(req.body.issueIndex) ? req.body.issueIndex : null;
    const replacementText = cleanText(req.body.replacementText, 3000);
    const content = cleanText(req.body.content, 8000);
    const anchorKind = req.body.anchorKind === "sentence" ? "sentence" : "entry";
    const anchorText = anchorKind === "sentence" ? cleanText(req.body.anchorText, 2000) : "";
    if (anchorKind === "sentence" && (!anchorText || !entry.body_markdown.includes(anchorText))) {
      return res.status(400).json({ success: false, error: "Choose a sentence from this diary as the annotation anchor" });
    }
    if (["add_factual_note", "add_relationship_note"].includes(action) && !content) {
      return res.status(400).json({ success: false, error: "Please write the annotation first" });
    }

    let supersedesEventId = null;
    if (action === "revoke_entry") {
      const { data: wholeEvents, error: wholeError } = await supabase.from("diary_review_events")
        .select("id,event_kind,created_at").eq("user_id", req.user.id).eq("shared_day_id", entry.shared_day_id)
        .in("event_kind", ["entry_confirmed", "entry_confirmation_revoked"])
        .order("created_at", { ascending: false }).limit(1);
      if (wholeError) throw wholeError;
      if (!wholeEvents?.length || wholeEvents[0].event_kind !== "entry_confirmed") {
        return res.status(409).json({ success: false, error: "This diary has no active whole-entry confirmation to revoke" });
      }
      supersedesEventId = wholeEvents[0].id;
    }

    let restoredIssues = [];
    if (action === "revoke_entry" && entry.supersedes_entry_id) {
      const { data: beforeConfirmation, error: beforeConfirmationError } = await supabase.from("diary_entries")
        .select("validation_issues").eq("id", entry.supersedes_entry_id).eq("user_id", req.user.id).maybeSingle();
      if (beforeConfirmationError) throw beforeConfirmationError;
      restoredIssues = Array.isArray(beforeConfirmation?.validation_issues) ? beforeConfirmation.validation_issues : [];
    }
    const review = applyDiaryReview(entry, { action, issueIndex, replacementText, restoredIssues });
    const eventId = crypto.randomUUID();
    const resultEntryId = review.changesEntry ? crypto.randomUUID() : null;
    const sourceMessageIds = ["confirm_fact", "confirm_entry"].includes(action)
      ? entry.source_message_ids : [];
    const { data: result, error: saveError } = await supabase.rpc("append_diary_review", {
      p_event_id: eventId, p_user_id: req.user.id, p_entry_id: entry.id,
      p_event_kind: reviewEventForAction(action),
      p_scope: ["add_factual_note", "add_relationship_note"].includes(action) ? "annotation"
        : action === "confirm_entry" || action === "revoke_entry" ? "entry" : "fact",
      p_issue_index: issueIndex, p_anchor_kind: anchorKind, p_anchor_text: anchorText || null,
      p_content: content || null, p_replacement_text: replacementText || null,
      p_provenance: action === "add_relationship_note" ? "relationship_note" : "user_later_confirmation",
      p_source_message_ids: sourceMessageIds, p_supersedes_event_id: supersedesEventId,
      p_batch_id: null, p_result_entry_id: resultEntryId,
      p_result_status: review.changesEntry ? review.status : null,
      p_result_body_markdown: review.changesEntry ? review.bodyMarkdown : null,
      p_result_validation_issues: review.changesEntry ? review.validationIssues : null,
    });
    if (saveError) throw saveError;
    const response = { success: true, result };
    if (resultEntryId) {
      const { data: nextEntry, error: nextError } = await supabase.from("diary_entries").select("*,shared_life_days(day_key)")
        .eq("id", resultEntryId).eq("user_id", req.user.id).single();
      if (nextError) throw nextError;
      response.entry = nextEntry;
    }
    res.status(201).json(response);
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/diary/jobs", async (req, res) => {
  try {
    const character = req.query.characterId
      ? await getOwnedCharacter(req.query.characterId, req.user.id)
      : await getOrCreateDefaultCharacter(req.user.id);
    const { data, error } = await supabase.from("diary_generation_jobs").select("*")
      .eq("user_id", req.user.id).eq("character_id", character.id)
      .order("created_at", { ascending: false }).limit(120);
    if (error) throw error;
    res.json({ success: true, jobs: data || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/diary/jobs/:jobId", async (req, res) => {
  const { data, error } = await supabase.from("diary_generation_jobs").select("*")
    .eq("id", req.params.jobId).eq("user_id", req.user.id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Diary job not found" });
  res.json({ success: true, job: data });
});

module.exports = router;