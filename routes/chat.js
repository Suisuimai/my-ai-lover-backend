const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const {
  DEFAULT_SETTINGS,
  getSettings,
  getOwnedCharacter,
  getOrCreateDefaultCharacter,
  getOrCreateUserProfile,
  loadPromptDocuments,
  loadWindowContinuity,
  createSession,
  touchSession,
  requireOwnedSession,
  createTitle,
  recallMemories,
  loadStatusFollowUps,
  extractLongTermMemories,
  saveExplicitMemory,
  saveExplicitFollowUp,
  maybeCompressMemory,
} = require("../services/data");
const { callModel } = require("../services/model");
const { recallSharedDay } = require("../services/recall");
const { refreshSharedDaysAfterMarker } = require("../services/diary");
const { validUuid, DEFAULT_SESSION_NAME } = require("../services/helpers");
const {
  buildModelContext,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
} = require("../core/context");
const {
  formatPromptDocuments,
  formatRetrievedPromptDocuments,
  selectRelevantPromptDocuments,
} = require("../core/promptDocuments");
const { formatWindowContinuity } = require("../core/handoff");
const {
  formatFollowUps,
  selectRelevantFollowUps,
  selectContextualFollowUps,
  suggestFollowUpStatus,
  parseExplicitFollowUpRequest,
} = require("../core/followup");
const {
  formatLongTermMemories,
  rankMemories,
  parseExplicitMemoryRequest,
} = require("../core/memory");
const { hasMorningMarker, hasNightMarker } = require("../core/sharedDays");

const activeChatControllers = new Map();

async function completedChatRequestResponse(request, userId) {
  const [{ data: assistant, error: assistantError }, { data: session, error: sessionError }] = await Promise.all([
    supabase.from("messages").select("id,content,generation_status,finish_reason,continues_message_id").eq("id", request.assistant_message_id).maybeSingle(),
    supabase.from("sessions").select("id,name").eq("id", request.session_id).eq("user_id", userId).maybeSingle(),
  ]);
  if (assistantError || sessionError) throw assistantError || sessionError;
  if (!assistant || !session) throw new Error("Completed chat result is no longer available");
  return {
    success: true,
    requestStatus: request.status,
    clientRequestId: request.id,
    sessionId: session.id,
    title: session.name,
    reply: assistant.content,
    messageId: assistant.id,
    generationStatus: assistant.generation_status,
    finishReason: assistant.finish_reason,
    continuesMessageId: assistant.continues_message_id,
    recovered: true,
  };
}

router.get("/chat-requests/:requestId", async (req, res) => {
  if (!validUuid(req.params.requestId)) return res.status(400).json({ success: false, error: "Invalid request ID" });
  try {
    const { data: request, error } = await supabase.from("chat_requests").select("*")
      .eq("id", req.params.requestId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ success: false, error: "Chat request not found" });
    if (["succeeded","truncated"].includes(request.status)) return res.json(await completedChatRequestResponse(request, req.user.id));
    res.json({ success: true, requestStatus: request.status, clientRequestId: request.id, sessionId: request.session_id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/chat-requests/:requestId/cancel", async (req, res) => {
  if (!validUuid(req.params.requestId)) return res.status(400).json({ success: false, error: "Invalid request ID" });
  try {
    const { data: request, error } = await supabase.from("chat_requests").select("id,status")
      .eq("id", req.params.requestId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ success: false, error: "Chat request not found" });
    activeChatControllers.get(request.id)?.abort();
    res.json({ success: true, requestStatus: request.status === "pending" ? "cancelling" : request.status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/chat", async (req, res) => {
  const requestStartedClock = Date.now();
  const phases = {};
  const message = typeof req.body.message === "string" ? req.body.message : "";
  if (!message.trim()) return res.status(400).json({ success: false, error: "A message is required" });
  const clientRequestId = req.body.clientRequestId;
  if (!validUuid(clientRequestId)) return res.status(400).json({ success: false, error: "A valid clientRequestId is required" });

  const wantsStream = req.headers.accept?.includes("text/event-stream");
  const operation = ["send", "regenerate", "edit", "continue"].includes(req.body.operation) ? req.body.operation : "send";
  const targetMessageId = req.body.targetMessageId;
  const abortController = new AbortController();
  let trackedRequest = null;
  let streamedReply = "";
  let streamClosed = false;
  let modelCompletion = { complete: false, status: "unknown", finishReason: null };
  const sendStreamEvent = (event, data) => {
    if (!wantsStream || res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }
  try {
    const { data: existingRequest, error: existingRequestError } = await supabase.from("chat_requests").select("*")
      .eq("id", clientRequestId).eq("user_id", req.user.id).maybeSingle();
    if (existingRequestError) throw existingRequestError;
    if (existingRequest?.request_text !== undefined && existingRequest.request_text !== message) {
      if (wantsStream) { sendStreamEvent("error", { error: "This retry ID belongs to different text" }); return res.end(); }
      return res.status(409).json({ success: false, error: "This retry ID belongs to different text" });
    }
    if (["succeeded","truncated"].includes(existingRequest?.status)) {
      const completed = await completedChatRequestResponse(existingRequest, req.user.id);
      if (wantsStream) { sendStreamEvent("done", completed); return res.end(); }
      return res.json(completed);
    }
    if (existingRequest?.status === "pending") {
      const pending = { success: true, requestStatus: "pending", clientRequestId, sessionId: existingRequest.session_id };
      if (wantsStream) { sendStreamEvent("error", { ...pending, error: "这条回复仍在生成，请稍后再试。" }); return res.end(); }
      return res.status(202).json(pending);
    }

    let sessionId = existingRequest?.session_id || req.body.sessionId;
    let isNewSession = false;

    if (existingRequest) {
      req.sessionRecord = await requireOwnedSession(sessionId, req.user.id);
      const { data, error } = await supabase.from("chat_requests").update({
        status: "pending", error_code: null, updated_at: new Date().toISOString(), completed_at: null,
      }).eq("id", clientRequestId).eq("user_id", req.user.id).select().single();
      if (error) throw error;
      trackedRequest = data;
    } else if (!sessionId) {
      const session = await createSession(req.user.id, DEFAULT_SESSION_NAME, req.body.characterId);
      sessionId = session.id;
      req.sessionRecord = session;
      isNewSession = true;
    } else {
      req.sessionRecord = await requireOwnedSession(sessionId, req.user.id);
    }

    const settingsPromise = getSettings(req.user.id);
    const characterPromise = req.sessionRecord.character_id
      ? getOwnedCharacter(req.sessionRecord.character_id, req.user.id)
      : getOrCreateDefaultCharacter(req.user.id);
    const userProfilePromise = getOrCreateUserProfile(req.user.id);
    let requestLinkPromise = Promise.resolve();

    if (!trackedRequest) {
      const { data, error } = await supabase.from("chat_requests").insert({
        id: clientRequestId, user_id: req.user.id, session_id: sessionId, request_text: message, status: "pending",
      }).select().single();
      if (error) throw error;
      trackedRequest = data;
    }

    activeChatControllers.set(clientRequestId, abortController);

    if (operation !== "send") {
      const { data: target, error: targetError } = await supabase.from("messages")
        .select("id,session_id,role,content,created_at")
        .eq("id", targetMessageId).eq("session_id", sessionId).maybeSingle();
      if (targetError) throw targetError;
      const expectedRole = operation === "edit" ? "user" : "assistant";
      if (!target || target.role !== expectedRole) {
        const invalidTarget = new Error(`A valid ${expectedRole} target message is required`);
        invalidTarget.status = 400;
        throw invalidTarget;
      }
      if (operation === "edit") {
        const { error: updateError } = await supabase.from("messages").update({ content: message, context_status: "active" }).eq("id", target.id);
        if (updateError) throw updateError;
        const { error: discardError } = await supabase.from("messages").update({ context_status: "discarded", is_visible: false })
          .eq("session_id", sessionId).gt("created_at", target.created_at);
        if (discardError) throw discardError;
        trackedRequest.user_message_id = target.id;
        await supabase.from("chat_requests").update({ user_message_id: target.id }).eq("id", clientRequestId);
      } else if (operation === "regenerate") {
        const { error: alternativeError } = await supabase.from("messages").update({ context_status: "alternative" }).eq("id", target.id);
        if (alternativeError) throw alternativeError;
        const { data: precedingUser, error: precedingError } = await supabase.from("messages").select("id")
          .eq("session_id", sessionId).eq("role", "user").eq("context_status", "active")
          .lt("created_at", target.created_at).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (precedingError) throw precedingError;
        if (precedingUser) {
          trackedRequest.user_message_id = precedingUser.id;
          await supabase.from("chat_requests").update({ user_message_id: precedingUser.id }).eq("id", clientRequestId);
        }
      }
    }

    if (!trackedRequest.user_message_id && operation === "send") {
      const { data: userMessage, error: userMessageError } = await supabase
        .from("messages")
        .insert({ session_id: sessionId, role: "user", content: message, is_visible: true })
        .select("id").single();
      if (userMessageError) throw userMessageError;
      trackedRequest = { ...trackedRequest, user_message_id: userMessage.id };
      requestLinkPromise = supabase.from("chat_requests").update({
        user_message_id: userMessage.id, updated_at: new Date().toISOString(),
      }).eq("id", clientRequestId).eq("user_id", req.user.id).then(({ error }) => {
        if (error) throw error;
      });
    }

    const heartbeatPromise = supabase.from("heartbeat_settings").update({
      last_chat_at: new Date().toISOString(), next_due_at: null, updated_at: new Date().toISOString(),
    }).eq("user_id", req.user.id).then(({ error }) => {
      if (error) console.error("Heartbeat timer reset failed:", error.code || "database_error");
    });

    const [settings, character, userProfile] = await Promise.all([
      settingsPromise, characterPromise, userProfilePromise, requestLinkPromise, heartbeatPromise,
    ]);
    phases.settingsAndProfile = Date.now() - requestStartedClock;

    const loadMemorySummary = async () => {
      try { return await maybeCompressMemory(sessionId, settings, req.user.id); }
      catch (compressionError) {
        console.error("Memory compression failed:", compressionError);
        const { data: existingMemory, error: memoryError } = await supabase.from("session_memories")
          .select("summary").eq("session_id", sessionId).maybeSingle();
        if (memoryError) throw memoryError;
        return existingMemory?.summary;
      }
    };
    const loadRecentHistory = async () => {
      const { data, error } = await supabase.from("messages").select("role, content")
        .eq("session_id", sessionId).eq("is_visible", true).eq("context_status", "active")
        .order("created_at", { ascending: false })
        .limit(normalizeRecentMessageLimit(settings.recent_message_limit));
      if (error) throw error;
      return data || [];
    };
    const [promptDocuments, continuity, relevantMemories, statusFollowUps, memorySummary, recentHistory, recalledSharedDay] = await Promise.all([
      loadPromptDocuments(req.user.id, character.id),
      loadWindowContinuity(req.user.id, req.sessionRecord),
      recallMemories(req.user.id, character.id, message).catch((error) => {
        console.error("Long-term memory recall failed:", error);
        return [];
      }),
      loadStatusFollowUps(req.user.id, character.id).catch((error) => {
        console.error("Follow-up recall failed:", error);
        return [];
      }),
      loadMemorySummary(),
      loadRecentHistory(),
      recallSharedDay({userId:req.user.id,characterId:character.id,sessionId,message,allowSemantic:false,writePointer:true}).catch((error)=>{
        console.error("Shared-day recall failed:",error.message); return "";
      }),
    ]);
    phases.contextAssembly = Date.now() - requestStartedClock - phases.settingsAndProfile;

    const onDemandDocuments = selectRelevantPromptDocuments(promptDocuments, message, 3);
    let relevantFollowUps = [];
    const conversationalFollowUps = statusFollowUps.filter((item) => ["active", "waiting"].includes(item.status));
    relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, recentHistory, 1);
    }
    const statusRelevantFollowUps = selectContextualFollowUps(statusFollowUps, message, recentHistory, 1);
    const historyChronological = [...recentHistory].reverse();
    const context = buildModelContext({
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
      memorySummary,
      recentMessages: historyChronological,
    });
    if (operation === "continue") {
      context.splice(Math.max(0, context.length - historyChronological.length), 0, {
        role: "system",
        content: "The immediately preceding assistant message was cut off by the transport or output limit. Continue that reply naturally from where it stopped. Do not repeat or rewrite the existing partial message; produce only the continuation as a new assistant message.",
      });
    }

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : settings.model;
    phases.totalPreparation = Date.now() - requestStartedClock;
    console.log("[chat] preparation phases (ms):", JSON.stringify(phases));
    const preparationMs = phases.totalPreparation;
    const reply = await callModel({
        purpose: "companion_chat",
        model: requestedModel,
        temperature: settings.temperature,
        thinking: "disabled",
        maxTokens: Math.max(1200, Number(settings.max_tokens) || 1200),
        messages: context,
        userId: req.user.id,
        sessionId,
        signal: abortController.signal,
        preparationMs,
        onDelta: wantsStream ? (delta, complete) => {
          streamedReply = complete;
          sendStreamEvent("delta", { delta });
        } : undefined,
        onCompletion: (value) => { modelCompletion = value; },
      });

    const generationStatus = modelCompletion.complete
      ? "complete"
      : modelCompletion.status === "length" ? "truncated_length"
        : modelCompletion.status === "abnormal_eof" ? "truncated_eof" : "truncated_unknown";

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("messages")
      .insert({
        session_id: sessionId, role: "assistant", content: reply, is_visible: true, context_status: "active",
        generation_status: generationStatus, finish_reason: modelCompletion.finishReason,
        ...(operation === "continue" ? { continues_message_id: targetMessageId } : {}),
        ...(operation === "regenerate" ? { replaces_message_id: targetMessageId } : {}),
      })
      .select()
      .single();
    if (assistantMessageError) throw assistantMessageError;

    let title;
    if (isNewSession) {
      title = message.slice(0, 16) || DEFAULT_SESSION_NAME;
      void createTitle(requestedModel, message, reply, req.user.id).then(async (generatedTitle) => {
        const { error: titleError } = await supabase.from("sessions")
          .update({ name: generatedTitle, updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", req.user.id);
        if (titleError) console.error("Session title update failed:", titleError);
      }).catch((error) => console.error("Background title generation failed:", error));
    } else {
      void touchSession(sessionId, req.user.id).catch((error) => console.error("Session timestamp update failed:", error));
    }

    const ruleBasedSuggestion = suggestFollowUpStatus(statusRelevantFollowUps, message);
    const followUpStatusSuggestion = ruleBasedSuggestion ? { action: "update", ...ruleBasedSuggestion } : null;
    const explicitMemory = parseExplicitMemoryRequest(message);
    const explicitFollowUp = parseExplicitFollowUpRequest(message);
    let capturedMemoryId = null;
    if (explicitMemory) {
      try {
        const captured = await saveExplicitMemory({ userId: req.user.id, characterId: character.id, sessionId, candidate: explicitMemory });
        capturedMemoryId = captured.id;
      } catch (memoryError) { console.error("Explicit long-term memory save failed:", memoryError); }
    }
    let followUpCapture = explicitFollowUp ? "failed" : "none";
    if (explicitFollowUp) {
      try {
        await saveExplicitFollowUp({ userId: req.user.id, characterId: character.id, sessionId, candidate: explicitFollowUp });
        followUpCapture = "saved";
      } catch (followUpError) { console.error("Explicit follow-up save failed:", followUpError); }
    }

    const { error: requestUpdateError } = await supabase.from("chat_requests").update({
      status: modelCompletion.complete ? "succeeded" : "truncated",
      assistant_message_id: assistantMessage.id,
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_code: null,
    }).eq("id", clientRequestId).eq("user_id", req.user.id);
    if (requestUpdateError) console.error("Chat request completion tracking failed:", requestUpdateError);
    if (operation === "send" && (hasMorningMarker(message) || hasNightMarker(message))) {
      setImmediate(() => refreshSharedDaysAfterMarker(req.user.id, character.id).catch((reason) => console.error("Marker shared-day refresh failed:", reason.message)));
    }

    const responsePayload = {
      success: true, requestStatus: "succeeded", clientRequestId, sessionId, title, reply,
      messageId: assistantMessage.id,
      memoryCapture: explicitMemory ? (capturedMemoryId ? "saved" : "failed") : "automatic_disabled",
      followUpCapture, followUpStatusSuggestion, operation,
      targetMessageId: targetMessageId || null, generationStatus, finishReason: modelCompletion.finishReason,
    };
    if (wantsStream) {
      sendStreamEvent(modelCompletion.complete ? "done" : "truncated", responsePayload);
      streamClosed = true;
      res.end();
    } else {
      res.json(responsePayload);
    }
  } catch (error) {
    console.error("Chat failed:", error);
    const cancelled = error?.name === "AbortError" || abortController.signal.aborted;
    if (operation === "regenerate" && targetMessageId && (!cancelled || !streamedReply.trim())) {
      const { error: restoreError } = await supabase.from("messages").update({ context_status: "active" }).eq("id", targetMessageId);
      if (restoreError) console.error("Original reply restore failed:", restoreError);
    }
    if (cancelled && trackedRequest?.session_id) {
      try {
        let partialMessage = null;
        if (streamedReply.trim()) {
          const { data, error: partialInsertError } = await supabase.from("messages").insert({
            session_id: trackedRequest.session_id, role: "assistant", content: streamedReply.trim(),
            is_visible: true, context_status: "active", generation_status: "stopped",
            ...(operation === "regenerate" ? { replaces_message_id: targetMessageId } : {}),
          }).select("id").single();
          if (partialInsertError) throw partialInsertError;
          partialMessage = data;
        }
        await supabase.from("chat_requests").update({
          status: "cancelled", partial_content: streamedReply.trim() || null, assistant_message_id: partialMessage?.id || null,
          completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_code: null,
        }).eq("id", trackedRequest.id).eq("user_id", req.user.id);
        if (wantsStream) {
          sendStreamEvent("cancelled", { requestStatus: "cancelled", reply: streamedReply.trim(), messageId: partialMessage?.id || null, sessionId: trackedRequest.session_id });
          streamClosed = true;
          return res.end();
        }
      } catch (partialError) { console.error("Partial reply save failed:", partialError); }
    }
    if (trackedRequest?.id) {
      try {
        await supabase.from("chat_requests").update({
          status: cancelled ? "cancelled" : "failed",
          error_code: error?.code ? String(error.code).slice(0, 120) : "chat_failed",
          completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", trackedRequest.id).eq("user_id", req.user.id);
      } catch { console.error("Chat request failure tracking failed"); }
    }
    if (wantsStream) {
      if (!streamClosed) sendStreamEvent("error", { error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
      return res.end();
    }
    res.status(cancelled ? 409 : 500).json({ success: false, error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
  } finally {
    activeChatControllers.delete(clientRequestId);
  }
});

module.exports = router;
