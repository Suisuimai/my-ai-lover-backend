const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { getSettings, getOwnedCharacter, getOrCreateDefaultCharacter, getOrCreateUserProfile, requireOwnedSession, loadPromptDocuments, loadWindowContinuity, getModelTarget, textUpdate } = require("../services/auth");
const { recallSharedDay } = require("../services/recall");
const {
  selectConversationWindow,
  buildModelContextLayers,
  estimateTokens,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
} = require("../core/context");
const { formatPromptDocuments, formatRetrievedPromptDocuments, selectRelevantPromptDocuments } = require("../core/promptDocuments");
const { formatFollowUps, selectRelevantFollowUps, selectContextualFollowUps } = require("../core/followup");
const { rankMemories, formatLongTermMemories } = require("../core/memory");
const { formatWindowContinuity } = require("../core/handoff");

// Read-only preview of the exact context layers used by companion chat.
router.post("/prompt-preview", async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : null;
    const requestedCharacterId = typeof req.body.characterId === "string" ? req.body.characterId : null;
    const settings = await getSettings(req.user.id);

    let session = null;
    if (sessionId) session = await requireOwnedSession(sessionId, req.user.id);
    const character = session?.character_id
      ? await getOwnedCharacter(session.character_id, req.user.id)
      : requestedCharacterId
        ? await getOwnedCharacter(requestedCharacterId, req.user.id)
        : await getOrCreateDefaultCharacter(req.user.id);

    const [userProfile, promptDocuments, memoryResult, followUpResult, summaryResult, historyResult] = await Promise.all([
      getOrCreateUserProfile(req.user.id),
      loadPromptDocuments(req.user.id, character.id),
      // --- Legacy long-term memory disabled (Fix #3) ---
      Promise.resolve({ data: [], error: null }),
      // --- Legacy follow-ups disabled (Fix #3) ---
      Promise.resolve([]),
      sessionId
        ? supabase.from("session_memories").select("summary").eq("session_id", sessionId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sessionId
        ? supabase.from("messages").select("role,content").eq("session_id", sessionId).eq("is_visible", true).eq("context_status", "active")
          .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (memoryResult.error) throw memoryResult.error;
    if (summaryResult.error) throw summaryResult.error;
    if (historyResult.error) throw historyResult.error;
    const continuity = await loadWindowContinuity(req.user.id, session);

    const previewWindow = selectConversationWindow([
      ...(historyResult.data || []),
      ...(message ? [{ role: "user", content: message }] : []),
    ]);
    const recentMessages = previewWindow.messages;
    const recentLatestFirst = recentMessages.slice(-normalizeRecentMessageLimit(settings.recent_message_limit)).reverse();
    const relevantMemories = rankMemories(memoryResult.data || [], message, 5);
    const conversationalFollowUps = followUpResult.filter((item) => ["active", "waiting"].includes(item.status));
    let relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, recentLatestFirst, 1);
    }
    const onDemandDocuments = selectRelevantPromptDocuments(promptDocuments, message, 3);
    const recalledSharedDay = message ? await recallSharedDay({
      userId:req.user.id,characterId:character.id,sessionId,message,allowSemantic:false,writePointer:false,
    }).catch((error)=>{console.error("Prompt preview source recall failed:",error.message);return "";}) : "";
    const modelTarget = await getModelTarget({
      userId: req.user.id,
      purpose: "companion_chat",
      legacyModel: settings.model,
    });
    const layers = buildModelContextLayers({
      systemPrompt: settings.system_prompt
        ? `User-configured system instructions:\n${settings.system_prompt}`
        : "",
      promptDocuments: formatPromptDocuments(promptDocuments),
      currentContext: formatCurrentTime(),
      topicDocuments: formatRetrievedPromptDocuments(onDemandDocuments),
      characterProfile: formatCharacterProfile(character),
      userProfile: formatUserProfile(userProfile),
      windowContinuity: formatWindowContinuity(continuity.handoff, continuity.tailMessages),
      recalledSharedDay,
      followUps: formatFollowUps(relevantFollowUps),
      longTermMemories: formatLongTermMemories(relevantMemories),
      memorySummary: previewWindow.start > 0 ? summaryResult.data?.summary : "",
      recentMessages,
    }).map((layer, index) => ({
      ...layer,
      order: index + 1,
      characters: layer.content.length,
      estimatedTokens: estimateTokens(layer.content),
    }));

    res.json({
      success: true,
      preview: {
        model: modelTarget.model,
        connectionId: modelTarget.connectionId,
        character: { id: character.id, name: character.name },
        sessionId,
        hypotheticalMessage: message,
        layers,
        totals: {
          layers: layers.length,
          characters: layers.reduce((total, layer) => total + layer.characters, 0),
          estimatedTokens: layers.reduce((total, layer) => total + layer.estimatedTokens, 0),
        },
        documents: {
          always: promptDocuments.filter((document) => document.is_enabled
            && (!document.load_mode || document.load_mode === "always")
            && document.confirmation_status !== "suggested").map(({ id, name }) => ({ id, name })),
          onDemandMatched: onDemandDocuments.map(({ id, name }) => ({ id, name })),
        },
        notice: "Token counts are estimates. This preview does not call a model, spend API credit, persist the message, or update recall counters.",
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;