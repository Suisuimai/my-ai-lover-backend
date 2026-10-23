const express = require("express");
const { supabase } = require("../services/db");
const { getOwnedCharacter, getOrCreateDefaultCharacter } = require("../services/data");
const { sourceIndexStatus, buildSourceIndexBatch, querySourceRecallCandidates, readAllOwnedSourceMessages } = require("../services/recall");
const { cleanText } = require("../core/diaryReview");

const router = express.Router();

router.get("/memory-index/status", async (req, res) => {
  try {
    const character = req.query.characterId ? await getOwnedCharacter(req.query.characterId, req.user.id) : await getOrCreateDefaultCharacter(req.user.id);
    res.json({ success: true, status: await sourceIndexStatus(req.user.id, character.id) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/memory-index/build", async (req, res) => {
  try {
    const character = req.body.characterId ? await getOwnedCharacter(req.body.characterId, req.user.id) : await getOrCreateDefaultCharacter(req.user.id);
    const status = await buildSourceIndexBatch(req.user.id, character.id, { includeEmbeddings: req.body.includeEmbeddings !== false, embeddingLimit: Math.min(192, Math.max(1, Number(req.body.embeddingLimit) || 96)) });
    res.json({ success: true, status });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/memory-index/test", async (req, res) => {
  try {
    const message = cleanText(req.body.message);
    if (!message) return res.status(400).json({ success: false, error: "请输入要测试的回忆问法" });
    const character = req.body.characterId ? await getOwnedCharacter(req.body.characterId, req.user.id) : await getOrCreateDefaultCharacter(req.user.id);
    const result = await querySourceRecallCandidates({ userId: req.user.id, characterId: character.id, message, allowSemantic: true });
    const dayIds = [...new Set([...result.lexicalMatches, ...result.semanticMatches].map((item) => item.shared_day_id))];
    const { data: days, error: dayError } = dayIds.length ? await supabase.from("shared_life_days").select("id,day_key").eq("user_id", req.user.id).in("id", dayIds) : { data: [], error: null };
    if (dayError) throw dayError;
    const dayById = new Map((days || []).map((day) => [day.id, day.day_key]));
    const { data: diaryStatuses, error: diaryStatusError } = dayIds.length ? await supabase.from("diary_entries").select("shared_day_id,status,created_at").eq("user_id", req.user.id).eq("character_id", character.id).in("shared_day_id", dayIds).order("created_at", { ascending: false }) : { data: [], error: null };
    if (diaryStatusError) throw diaryStatusError;
    const confirmed = new Map();
    for (const entry of diaryStatuses || []) if (!confirmed.has(entry.shared_day_id)) confirmed.set(entry.shared_day_id, entry.status === "confirmed");
    const bestByDay = (items, valueKey) => {
      const seen = new Set();
      return items.filter((item) => { if (seen.has(item.shared_day_id)) return false; seen.add(item.shared_day_id); return true; }).slice(0, 5).map((item) => ({ dayKey: dayById.get(item.shared_day_id) || "未知日期", score: Number(item[valueKey] || 0), confirmed: Boolean(confirmed.get(item.shared_day_id)) }));
    };
    const lexicalByDay = new Map();
    for (const item of result.lexicalMatches) if (!lexicalByDay.has(item.shared_day_id)) lexicalByDay.set(item.shared_day_id, item);
    const semanticDays = new Set(result.semanticMatches.map((item) => item.shared_day_id));
    const sourceById = new Map((await readAllOwnedSourceMessages(req.user.id, character.id)).map((source) => [source.id, source]));
    const accepted = result.ranked.slice(0, 5).map((item) => {
      const lexical = lexicalByDay.get(item.sharedDayId);
      const sourceIds = lexical?.source_message_ids || item.anchorSourceMessageIds || [];
      const evidence = sourceIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => ({
        id: source.id, role: source.role, content: source.raw_content,
        occurredAt: source.source_metadata?.original_message_created_at || source.occurred_at,
      }));
      const normalizedEvidence = evidence.map((message) => String(message.content || "").normalize("NFKC").toLowerCase()).join("\n");
      const matchedTerms = result.terms.filter((term) => normalizedEvidence.includes(String(term).normalize("NFKC").toLowerCase()));
      return { dayKey: dayById.get(item.sharedDayId) || "未知日期", score: item.score, confirmed: Boolean(confirmed.get(item.sharedDayId)), channels: semanticDays.has(item.sharedDayId) ? ["BM25", "BGE-M3"] : ["BM25"], matchedTerms, evidence };
    });
    res.json({ success: true, test: { queryTerms: result.terms, embeddingModel: result.embeddingModel, lexical: bestByDay(result.lexicalMatches, "lexical_score"), semantic: bestByDay(result.semanticMatches, "similarity"), accepted, found: accepted.length > 0 } });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
