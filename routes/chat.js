const { performance } = require("node:perf_hooks");
const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { createChatTiming, persistChatUsage } = require("../core/chatTiming");
const { startChatTask } = require("../core/chatPreparation");
const { cachedPrefix, usageTouchedCache } = require("../core/cacheKeepAlive");
const {
  buildModelContext,
  buildModelContextLayers,
  summarizeContextLayers,
  selectConversationWindow,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
} = require("../core/context");
const { formatPromptDocuments, formatRetrievedPromptDocuments, selectRelevantPromptDocuments } = require("../core/promptDocuments");
const { formatFollowUps, selectRelevantFollowUps, selectContextualFollowUps } = require("../core/followup");
const { rankMemories, formatLongTermMemories } = require("../core/memory");
const { formatWindowContinuity } = require("../core/handoff");
const { hasMorningMarker, hasNightMarker } = require("../core/sharedDays");
const { requireOwnedSession, createSession, getOwnedCharacter, getOrCreateDefaultCharacter, getOrCreateUserProfile, getSettings, loadPromptDocuments, loadWindowContinuity, getModelTarget, DEFAULT_SESSION_NAME, recordModelUsage } = require("../services/auth");
const { callModel, createTitle, promptCacheKeepAlive } = require("../services/model");
const { compressMemoryInBackground, refreshSharedDaysAfterMarker, completedChatRequestResponse } = require("../services/data");
const { recallSharedDay } = require("../services/recall");
const { validUuid } = require("../services/helpers");

const activeChatControllers = new Map();

router.post("/messages/:messageId/select-variant", async (req, res) => {
  try {
    const { data: selected, error: selectedError } = await supabase.from("messages")
      .select("id,session_id,role,created_at,replaces_message_id")
      .eq("id", req.params.messageId).maybeSingle();
    if (selectedError) throw selectedError;
    if (!selected || selected.role !== "assistant") return res.status(404).json({ success: false, error: "Reply variant not found" });
    await requireOwnedSession(selected.session_id, req.user.id);
    const { data: assistants, error: assistantsError } = await supabase.from("messages")
      .select("id,replaces_message_id,created_at").eq("session_id", selected.session_id)
      .eq("role", "assistant").eq("is_visible", true).order("created_at", { ascending: true });
    if (assistantsError) throw assistantsError;
    const byId = new Map((assistants || []).map((message) => [message.id, message]));
    const rootOf = (message) => {
      let current = message;
      const seen = new Set();
      while (current?.replaces_message_id && byId.has(current.replaces_message_id) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.replaces_message_id);
      }
      return current?.id;
    };
    const rootId = rootOf(selected);
    const variantIds = (assistants || []).filter((message) => rootOf(message) === rootId).map((message) => message.id);
    if (variantIds.length < 2) return res.status(400).json({ success: false, error: "This reply has no alternatives" });
    const latestVariantTime = Math.max(...(assistants || []).filter((message) => variantIds.includes(message.id)).map((message) => new Date(message.created_at).getTime()));
    const { data: laterUser } = await supabase.from("messages").select("id").eq("session_id", selected.session_id)
      .eq("role", "user").eq("is_visible", true).eq("context_status", "active")
      .gt("created_at", new Date(latestVariantTime).toISOString()).limit(1).maybeSingle();
    if (laterUser) return res.status(409).json({ success: false, error: "继续聊天后不能再切换旧回复版本" });
    const { error: demoteError } = await supabase.from("messages").update({ context_status: "alternative" }).in("id", variantIds);
    if (demoteError) throw demoteError;
    const { error: selectError } = await supabase.from("messages").update({ context_status: "active" }).eq("id", selected.id);
    if (selectError) throw selectError;
    res.json({ success: true, selectedMessageId: selected.id, variantIds });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

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

// Core chat: persist user message, assemble context, call model, and keep retries idempotent.
router.post("/chat", async (req, res) => {
  const timing = req.chatTiming || createChatTiming();
  let chatUsageEvent;
  let roundSuccess = false;
  let keepAlivePayload = null;
  let compressionSessionId = null;
  let contextLayerSizes = null;
  const recallExplain = {};
  const requestStartedClock = performance.now();
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
    timing.mark("first_sse_data");
  };
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }
  try {
    const { data: existingRequest, error: existingRequestError } = await timing.measure("request_lookup", () => supabase.from("chat_requests").select("*")
      .eq("id", clientRequestId).eq("user_id", req.user.id).maybeSingle());
    if (existingRequestError) throw existingRequestError;
    if (existingRequest?.request_text !== undefined && existingRequest.request_text !== message) {
      if (wantsStream) {
        sendStreamEvent("error", { error: "This retry ID belongs to different text" });
        return res.end();
      }
      return res.status(409).json({ success: false, error: "This retry ID belongs to different text" });
    }
    if (["succeeded","truncated"].includes(existingRequest?.status)) {
      const completed = await completedChatRequestResponse(existingRequest, req.user.id);
      if (wantsStream) {
        sendStreamEvent("done", completed);
        return res.end();
      }
      return res.json(completed);
    }
    if (existingRequest?.status === "pending") {
      const pending = { success: true, requestStatus: "pending", clientRequestId, sessionId: existingRequest.session_id };
      if (wantsStream) {
        sendStreamEvent("error", { ...pending, error: "这条回复仍在生成，请稍后再试。" });
        return res.end();
      }
      return res.status(202).json(pending);
    }

    let sessionId = existingRequest?.session_id || req.body.sessionId;
    let isNewSession = false;

    if (existingRequest) {
      req.sessionRecord = await timing.measure("session_load", () => requireOwnedSession(sessionId, req.user.id));
      const { data, error } = await supabase.from("chat_requests").update({
        status: "pending", error_code: null, updated_at: new Date().toISOString(), completed_at: null,
      }).eq("id", clientRequestId).eq("user_id", req.user.id).select().single();
      if (error) throw error;
      trackedRequest = data;
    } else if (!sessionId) {
      const session = await timing.measure("session_load", () => createSession(req.user.id, DEFAULT_SESSION_NAME, req.body.characterId));
      sessionId = session.id;
      req.sessionRecord = session;
      isNewSession = true;
    } else {
      req.sessionRecord = await timing.measure("session_load", () => requireOwnedSession(sessionId, req.user.id));
    }

    // These reads do not depend on request/message persistence. Start them now
    // so database round trips overlap instead of forming a preparation waterfall.
    const settingsPromise = startChatTask(() => timing.measure("settings", () => getSettings(req.user.id)));
    const characterPromise = startChatTask(() => timing.measure("character", () => req.sessionRecord.character_id
      ? getOwnedCharacter(req.sessionRecord.character_id, req.user.id)
      : getOrCreateDefaultCharacter(req.user.id)));
    const userProfilePromise = startChatTask(() => timing.measure("user_profile", () => getOrCreateUserProfile(req.user.id)));
    const modelTargetPromise = startChatTask(async () => {
      const settings = await settingsPromise;
      const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
        ? req.body.model.trim()
        : settings.model;
      return timing.measure("model_routing", () => getModelTarget({
        userId: req.user.id, purpose: "companion_chat", legacyModel: requestedModel,
      }));
    });
    let requestLinkPromise = Promise.resolve();

    if (!trackedRequest) {
      const { data, error } = await timing.measure("request_persistence", () => supabase.from("chat_requests").insert({
        id: clientRequestId, user_id: req.user.id, session_id: sessionId, request_text: message, status: "pending",
      }).select().single());
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
      const { data: userMessage, error: userMessageError } = await timing.measure("user_message_persistence", () => supabase
        .from("messages")
        .insert({ session_id: sessionId, role: "user", content: message, is_visible: true })
        .select("id").single());
      if (userMessageError) throw userMessageError;
      trackedRequest = { ...trackedRequest, user_message_id: userMessage.id };
      requestLinkPromise = timing.measure("request_linkage", () => supabase.from("chat_requests").update({
        user_message_id: userMessage.id, updated_at: new Date().toISOString(),
      }).eq("id", clientRequestId).eq("user_id", req.user.id).then(({ error }) => {
        if (error) throw error;
      }));
    }

    const heartbeatPromise = timing.measure("heartbeat_reset", () => supabase.from("heartbeat_settings").update({
      last_chat_at: new Date().toISOString(), next_due_at: null, updated_at: new Date().toISOString(),
    }).eq("user_id", req.user.id).then(({ error }) => {
      if (error) throw error;
    })).catch(() => { console.error("Heartbeat timer reset failed"); });

    const loadMemorySummary = async () => {
      const { data: existingMemory, error: memoryError } = await supabase.from("session_memories")
        .select("summary").eq("session_id", sessionId).maybeSingle();
      if (memoryError) throw memoryError;
      return existingMemory?.summary;
    };
    const loadRecentHistory = async () => {
      const settings = await settingsPromise;
      const { data, error } = await supabase.from("messages").select("role, content")
        .eq("session_id", sessionId).eq("is_visible", true).eq("context_status", "active")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const selected = selectConversationWindow(data || []);
      const recentLimit = normalizeRecentMessageLimit(settings.recent_message_limit);
      return { ...selected, latestFirst: selected.messages.slice(-recentLimit).reverse() };
    };
    // Read current history/recall only after the user message or edit is saved.
    // Linkage/heartbeat still finish before generation, but no longer gate reads.
    const contextReadsPromise = Promise.all([
      characterPromise.then((character) => timing.measure("prompt_documents", () => loadPromptDocuments(req.user.id, character.id))),
      timing.measure("continuity", () => loadWindowContinuity(req.user.id, req.sessionRecord)),
      // --- Legacy long-term memory disabled (Fix #3) --- diary + source recall replaces slice-based memories ---
      Promise.resolve([]),
      // --- Legacy follow-ups disabled (Fix #3) --- good memory makes explicit follow-up tracking redundant ---
      Promise.resolve([]),
      settingsPromise.then(() => timing.measure("memory_summary", () => loadMemorySummary())),
      settingsPromise.then(() => timing.measure("recent_history", () => loadRecentHistory())),
      // Until BGE-M3 has a reliable calibrated threshold, semantic results are
      // unable to admit candidates on their own. Do not add ~10s of hot-path
      // work merely to reorder the same lexical days.
      characterPromise.then((character) => recallSharedDay({userId:req.user.id,characterId:character.id,sessionId,message,allowSemantic:false,writePointer:true,timing,explain:recallExplain})).catch((error)=>{
        console.error("Shared-day recall failed:",error.message); return "";
      }),
    ]);
    const [settings, character, userProfile, [promptDocuments, continuity, relevantMemories, statusFollowUps, storedSummary, conversationWindow, recalledSharedDay]] = await Promise.all([
      settingsPromise, characterPromise, userProfilePromise, contextReadsPromise, requestLinkPromise, heartbeatPromise,
    ]);
    const endPromptAssembly = timing.start("prompt_assembly");
    const onDemandDocuments = selectRelevantPromptDocuments(promptDocuments, message, 3);
    let relevantFollowUps = [];
    const conversationalFollowUps = statusFollowUps.filter((item) => ["active", "waiting"].includes(item.status));
    relevantFollowUps = selectRelevantFollowUps(conversationalFollowUps, message, 3);
    if (!relevantFollowUps.length) {
      relevantFollowUps = selectContextualFollowUps(conversationalFollowUps, message, conversationWindow.latestFirst, 1);
    }
    const statusRelevantFollowUps = selectContextualFollowUps(statusFollowUps, message, conversationWindow.latestFirst, 1);
    const historyChronological = conversationWindow.messages;
    // While the whole window fits, the full transcript replaces the summary.
    const memorySummary = conversationWindow.start > 0 ? storedSummary : "";
    const contextInput = {
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
    };
    const context = buildModelContext(contextInput);
    contextLayerSizes = summarizeContextLayers(buildModelContextLayers(contextInput));
    if (operation === "continue") {
      context.splice(Math.max(0, context.length - historyChronological.length), 0, {
        role: "system",
        content: "The immediately preceding assistant message was cut off by the transport or output limit. Continue that reply naturally from where it stopped. Do not repeat or rewrite the existing partial message; produce only the continuation as a new assistant message.",
      });
    }

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : settings.model;
    endPromptAssembly();
    const preparationMs = Math.max(0, performance.now() - requestStartedClock);
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
        timing,
        modelTargetPromise,
        onUsage: (event) => { chatUsageEvent = event; },
        onDelta: wantsStream ? (delta, complete) => {
          streamedReply = complete;
          sendStreamEvent("delta", { delta });
        } : undefined,
        onCompletion: (value) => { modelCompletion = value; },
      });
    compressionSessionId = sessionId;
    const prefix = cachedPrefix(context);
    if (prefix) keepAlivePayload = { userId: req.user.id, sessionId, model: requestedModel, temperature: settings.temperature, prefix };

    const generationStatus = modelCompletion.complete
      ? "complete"
      : modelCompletion.status === "length" ? "truncated_length"
        : modelCompletion.status === "abnormal_eof" ? "truncated_eof" : "truncated_unknown";

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("messages")
      .insert({
        session_id: sessionId,
        role: "assistant",
        content: reply,
        is_visible: true,
        context_status: "active",
        generation_status: generationStatus,
        finish_reason: modelCompletion.finishReason,
        recall_info: recallExplain.dayKey ? recallExplain : null,
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
      void supabase.from("sessions").update({ updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", req.user.id)
        .then(({ error }) => { if (error) console.error("Session timestamp update failed:", error); });
    }

    // --- Legacy follow-up status suggestion disabled (Fix #3) ---
    const followUpStatusSuggestion = null;
    // --- Legacy explicit memory + follow-up capture disabled (Fix #3) ---
    const explicitMemory = null;
    const capturedMemoryId = null;
    const followUpCapture = "none";

    const { error: requestUpdateError } = await supabase.from("chat_requests").update({
      status: modelCompletion.complete ? "succeeded" : "truncated",
      assistant_message_id: assistantMessage.id,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_code: null,
    }).eq("id", clientRequestId).eq("user_id", req.user.id);
    if (requestUpdateError) console.error("Chat request completion tracking failed:", requestUpdateError);
    if(operation==="send"&&(hasMorningMarker(message)||hasNightMarker(message))){
      setImmediate(()=>refreshSharedDaysAfterMarker(req.user.id,character.id).catch((reason)=>console.error("Marker shared-day refresh failed:",reason.message)));
    }

    const responsePayload = {
      success: true,
      requestStatus: "succeeded",
      clientRequestId,
      sessionId,
      title,
      reply,
      messageId: assistantMessage.id,
      memoryCapture: explicitMemory ? (capturedMemoryId ? "saved" : "failed") : "automatic_disabled",
      followUpCapture,
      followUpStatusSuggestion,
      operation,
      targetMessageId: targetMessageId || null,
      generationStatus,
      finishReason: modelCompletion.finishReason,
      recallInfo: recallExplain.dayKey ? recallExplain : null,
    };
    roundSuccess = modelCompletion.complete;
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
            session_id: trackedRequest.session_id,
            role: "assistant",
            content: streamedReply.trim(),
            is_visible: true,
            context_status: "active",
            generation_status: "stopped",
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
      } catch (partialError) {
        console.error("Partial reply save failed:", partialError);
      }
    }
    if (trackedRequest?.id) {
      try {
        await supabase.from("chat_requests").update({
          status: cancelled ? "cancelled" : "failed",
          error_code: error?.code ? String(error.code).slice(0, 120) : "chat_failed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", trackedRequest.id).eq("user_id", req.user.id);
      } catch {
        console.error("Chat request failure tracking failed");
      }
    }
    if (wantsStream) {
      if (!streamClosed) sendStreamEvent("error", { error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
      return res.end();
    }
    res.status(cancelled ? 409 : 500).json({ success: false, error: cancelled ? "已停止生成" : "这条消息暂时没有发送成功，请重试。" });
  } finally {
    timing.mark("round_complete", roundSuccess);
    if (chatUsageEvent && contextLayerSizes) {
      chatUsageEvent.provider_usage = { ...(chatUsageEvent.provider_usage || {}), context_layers: contextLayerSizes };
    }
    persistChatUsage(chatUsageEvent, timing, recordModelUsage);
    if (roundSuccess && compressionSessionId) compressMemoryInBackground(compressionSessionId, req.user.id);
    if (keepAlivePayload && usageTouchedCache(chatUsageEvent)) promptCacheKeepAlive.touch(req.user.id, keepAlivePayload);
    activeChatControllers.delete(clientRequestId);
  }
});

module.exports = router;
