const crypto = require("crypto");
const {
  selectConversationWindow,
} = require("../core/context");
const { groupSourceMessagesBySharedDay } = require("../core/sharedDays");
const { classifyDiaryGenerationError } = require("../core/diaryFailures");
const { buildGroundedDiaryPrompt, parseGroundedDiary, validateGroundedDiary } = require("../core/groundedDiary");
const { startChatTask } = require("../core/chatPreparation");

const { supabase } = require("./db");
const {
  getSettings,
  getModelTarget,
  readAllOwnedSourceMessages,
  latestSharedDayVersions,
  sourceIndexStatus,
  buildSourceIndexBatch,
} = require("./auth");
const { callModel } = require("./model");

const memoryCompressionsInFlight = new Set();

// Compression only covers messages that already fell out of the recent window, so it
// can run after the reply instead of delaying the next first token.
function compressMemoryInBackground(sessionId, userId) {
  if (memoryCompressionsInFlight.has(sessionId)) return;
  memoryCompressionsInFlight.add(sessionId);
  getSettings(userId)
    .then((settings) => maybeCompressMemory(sessionId, settings, userId))
    .catch(() => console.error("Memory compression failed"))
    .finally(() => memoryCompressionsInFlight.delete(sessionId));
}

async function maybeCompressMemory(sessionId, settings, userId) {
  const { data: memory, error: memoryError } = await supabase
    .from("session_memories")
    .select("summary, last_compressed_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (memoryError) throw memoryError;

  const { data: allMessages, error: messagesError } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .eq("is_visible", true)
    .eq("context_status", "active")
    .order("created_at", { ascending: true });
  if (messagesError) throw messagesError;

  // Only messages that no longer fit in the full-transcript window are summarized,
  // so the summary changes only when the window start moves.
  const { start } = selectConversationWindow(allMessages);
  if (start === 0) return memory?.summary;
  const retainedBoundary = allMessages[start].created_at;
  const messagesToCompress = allMessages.filter((item) =>
    item.created_at < retainedBoundary
    && (!memory?.last_compressed_at || item.created_at > memory.last_compressed_at)
  );

  if (!messagesToCompress.length) return memory?.summary;

  const transcript = messagesToCompress
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n");
  const summary = await callModel({
    purpose: "conversation_summary",
    model: settings.summary_model,
    temperature: 0.2,
    thinking: "disabled",
    maxTokens: 500,
    userId,
    messages: [{
      role: "system",
      content: "Maintain a compact factual memory for an AI companion. Preserve user preferences, important events, relationship context, commitments, and unresolved topics. Do not invent details.",
    }, {
      role: "user",
      content: `Existing memory summary:\n${memory?.summary || "(none)"}\n\nNew conversation to merge:\n${transcript}`,
    }],
  });

  const lastCompressedAt = messagesToCompress.at(-1).created_at;
  const { error: saveError } = await supabase
    .from("session_memories")
    .upsert({
      session_id: sessionId,
      summary,
      last_compressed_at: lastCompressedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "session_id" });
  if (saveError) throw saveError;

  return summary;
}

async function continueSourceIndexIfStarted(userId,characterId) {
  const status=await sourceIndexStatus(userId,characterId);
  // Auto-bootstrap: build index even when lexicalCount is 0, so the first diary
  // generation automatically populates the retrieval windows without a manual call.
  await buildSourceIndexBatch(userId,characterId,{includeEmbeddings:status.embeddingConfigured,embeddingLimit:192});
}

async function loadConfirmedDiaryForDay(userId,characterId,sharedDayId) {
  const {data,error}=await supabase.from("diary_entries").select("*").eq("user_id",userId).eq("character_id",characterId).eq("shared_day_id",sharedDayId)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw error; return data?.status==="confirmed"?data:null;
}

async function rebuildSharedLifeDays(userId,characterId) {
    const grouped = groupSourceMessagesBySharedDay(await readAllOwnedSourceMessages(userId,characterId));
    let appendedVersions = 0;
    for (const group of grouped) {
      let { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
        .eq("user_id",userId).eq("character_id",characterId).eq("day_key", group.dayKey).maybeSingle();
      if (dayError) throw dayError;
      if (!day) {
        const inserted = await supabase.from("shared_life_days").insert({
          user_id:userId,character_id:characterId,day_key:group.dayKey,
        }).select().single();
        if (inserted.error) throw inserted.error;
        day = inserted.data;
      }
      const { data: previous, error: previousError } = await supabase.from("shared_life_day_versions").select("*")
        .eq("shared_day_id", day.id).eq("user_id",userId)
        .order("revision_number", { ascending: false }).limit(1).maybeSingle();
      if (previousError) throw previousError;
      const sameSources = previous
        && JSON.stringify(previous.source_message_ids) === JSON.stringify(group.sourceMessageIds);
      const unchanged = sameSources
        && (previous.boundary_reason === "manual_end" || (
          previous.boundary_state === group.boundaryState
        && previous.boundary_reason === group.boundaryReason
        && previous.morning_marker_source_id === group.morningMarkerSourceId
        && previous.night_marker_source_id === group.nightMarkerSourceId));
      if (unchanged) continue;
      const { error: versionError } = await supabase.from("shared_life_day_versions").insert({
        shared_day_id:day.id,user_id:userId,character_id:characterId,
        revision_number: previous ? previous.revision_number + 1 : 0,
        started_at: group.startedAt, ended_at: group.endedAt,
        source_message_ids: group.sourceMessageIds,
        first_source_message_id: group.firstSourceMessageId,
        last_source_message_id: group.lastSourceMessageId,
        morning_marker_source_id: group.morningMarkerSourceId,
        night_marker_source_id: group.nightMarkerSourceId,
        boundary_state: group.boundaryState, boundary_reason: group.boundaryReason,
        supersedes_version_id: previous?.id || null,
      });
      if (versionError) throw versionError;
      appendedVersions += 1;
    }
    return {discoveredDays:grouped.length,appendedVersions};
}

async function processDiaryGenerationJob(jobId) {
  const { data: job, error: jobError } = await supabase.from("diary_generation_jobs").select("*")
    .eq("id", jobId).maybeSingle();
  if (jobError) throw jobError;
  if (!job || job.status !== "queued") return;
  const startedAt = new Date().toISOString();
  const { error: runningError } = await supabase.from("diary_generation_jobs").update({
    status: "running", started_at: startedAt, updated_at: startedAt, error_code: null, failure_stage: null,
  }).eq("id", job.id).eq("status", "queued");
  if (runningError) throw runningError;
  let failureStage = "source_read";
  try {
    const [{ data: day, error: dayError }, { data: version, error: versionError }] = await Promise.all([
      supabase.from("shared_life_days").select("*").eq("id", job.shared_day_id).eq("user_id", job.user_id).maybeSingle(),
      supabase.from("shared_life_day_versions").select("*").eq("id", job.shared_day_version_id).eq("user_id", job.user_id).maybeSingle(),
    ]);
    if (dayError || versionError) throw dayError || versionError;
    if (!day || !version || version.boundary_state !== "sealed") throw new Error("Only a sealed shared day can become a diary");
    const sourceById = new Map((await readAllOwnedSourceMessages(job.user_id, job.character_id)).map((message) => [message.id, message]));
    const sourceMessages = version.source_message_ids.map((id) => sourceById.get(id)).filter(Boolean).map((message) => ({
      ...message,
      effective_occurred_at: message.source_metadata?.original_message_created_at || message.occurred_at,
    }));
    if (sourceMessages.length !== version.source_message_ids.length) throw new Error("A diary source message is missing");
    const settings = await getSettings(job.user_id);
    const target = await getModelTarget({ userId:job.user_id, purpose:"diary_generation", legacyModel:settings.summary_model });
    await supabase.from("diary_generation_jobs").update({
      requested_model:target.model, source_message_count:sourceMessages.length, updated_at:new Date().toISOString(),
    }).eq("id",job.id);
    failureStage = "model_request";
    const raw = await callModel({
      purpose: "diary_generation", model: settings.summary_model, userId: job.user_id,
      // The diary body is intentionally compact, but the evidence arrays and
      // provider-side structured generation need additional completion room on
      // message-dense days. This changes capacity, not the diary's content caps.
      sessionId: job.shared_day_id, temperature: 0.2, maxTokens: 24000, responseFormat: "json_object", thinking: "disabled",
      messages: [
        { role: "system", content: "你只根据给定原始消息写有证据的第一人称中文日记，并严格返回指定 JSON。" },
        { role: "user", content: buildGroundedDiaryPrompt({ dayKey: day.day_key, messages: sourceMessages }) },
      ],
    });
    failureStage = "model_parse";
    const diary = parseGroundedDiary(raw, sourceMessages);
    failureStage = "validation";
    const validation = validateGroundedDiary(diary, sourceMessages, { dayKey: day.day_key });
    const importedDraft = sourceMessages.some((message) => message.source_kind === "claude_import");
    if (importedDraft && !validation.issues.some((issue) => issue.kind === "imported_draft")) {
      validation.issues.push({
        kind: "imported_draft", itemIndex: null, text: "",
        reasons: ["旧记录生成的日记默认保持草稿；只有妤妤主动确认后才进入未来检索。"],
      });
    }
    const status = validation.issues.length ? "needs_review" : "confirmed";
    const entryId = crypto.randomUUID();
    failureStage = "storage";
    const { error: saveError } = await supabase.rpc("save_grounded_diary", {
      p_entry_id: entryId, p_user_id: job.user_id, p_character_id: job.character_id,
      p_shared_day_id: day.id, p_shared_day_version_id: version.id, p_generation_job_id: job.id,
      p_status: status, p_title: diary.title, p_body_markdown: diary.bodyMarkdown,
      p_current_state: diary.currentState, p_source_message_ids: version.source_message_ids,
      p_validation_issues: validation.issues,
      p_facts: status === "confirmed"
        ? validation.validFacts.map((item) => ({ text: item.text, source_message_ids: item.sourceMessageIds }))
        : [],
      p_feelings: validation.validFeelings.map((item) => ({ text: item.text, source_message_ids: item.sourceMessageIds })),
    });
    if (saveError) throw saveError;
    const completedAt = new Date().toISOString();
    const { error: completeError } = await supabase.from("diary_generation_jobs").update({
      status: status === "confirmed" ? "succeeded" : "needs_review",
      completed_at: completedAt, updated_at: completedAt, error_code: null,
    }).eq("id", job.id);
    if (completeError) throw completeError;
    void continueSourceIndexIfStarted(job.user_id,job.character_id).catch((error)=>console.error("Background source indexing deferred:",error.message));
  } catch (error) {
    const completedAt = new Date().toISOString();
    await supabase.from("diary_generation_jobs").update({
      status: "failed", completed_at: completedAt, updated_at: completedAt,
      error_code: classifyDiaryGenerationError(error, failureStage), failure_stage:failureStage,
    }).eq("id", job.id);
    console.error("Diary generation failed:", error);
  }
}

function startDiaryJob(jobId) {
  setImmediate(() => processDiaryGenerationJob(jobId).catch((error) => console.error("Diary job crashed:", error)));
}

function startDiaryJobsSequentially(jobIds) {
  setImmediate(async () => {
    for (const jobId of jobIds) await processDiaryGenerationJob(jobId);
  });
}

async function createDiaryJobForLatestVersion({ userId, characterId, sharedDayId, retry = false }) {
  const { data: day, error: dayError } = await supabase.from("shared_life_days").select("*")
    .eq("id", sharedDayId).eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  if (dayError) throw dayError;
  if (!day) { const error = new Error("Shared life day not found"); error.status = 404; throw error; }
  const { data: version, error: versionError } = await supabase.from("shared_life_day_versions").select("*")
    .eq("shared_day_id", day.id).eq("user_id", userId).order("revision_number", { ascending: false }).limit(1).maybeSingle();
  if (versionError) throw versionError;
  if (!version || version.boundary_state !== "sealed") { const error = new Error("This shared day has not ended yet"); error.status = 409; throw error; }
  const { data: existing, error: existingError } = await supabase.from("diary_generation_jobs").select("*")
    .eq("shared_day_version_id", version.id).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing && (!retry || ["queued", "running", "succeeded"].includes(existing.status))) {
    return { job: existing, created: false };
  }
  const { count, error: countError } = await supabase.from("diary_generation_jobs").select("id", { count: "exact", head: true })
    .eq("shared_day_version_id", version.id).eq("user_id", userId);
  if (countError) throw countError;
  const { data: job, error: insertError } = await supabase.from("diary_generation_jobs").insert({
    user_id: userId, character_id: characterId, shared_day_id: day.id, shared_day_version_id: version.id,
    attempt_number: Number(count || 0) + 1, source_message_count:(version.source_message_ids||[]).length,
  }).select().single();
  if (insertError) throw insertError;
  return { job, created: true };
}

async function refreshSharedDaysAfterMarker(userId,characterId) {
  await rebuildSharedLifeDays(userId,characterId);
  const {data:days,error:dayError}=await supabase.from("shared_life_days").select("*")
    .eq("user_id",userId).eq("character_id",characterId).order("day_key",{ascending:false}).limit(10);
  if(dayError)throw dayError;
  const versions=await latestSharedDayVersions((days||[]).map((day)=>day.id),userId);
  const [{data:entries,error:entryError},{data:jobs,error:jobError}]=await Promise.all([
    supabase.from("diary_entries").select("shared_day_id").eq("user_id",userId).eq("character_id",characterId),
    supabase.from("diary_generation_jobs").select("shared_day_id").eq("user_id",userId).eq("character_id",characterId),
  ]);
  if(entryError||jobError)throw entryError||jobError;
  const used=new Set([...(entries||[]).map((item)=>item.shared_day_id),...(jobs||[]).map((item)=>item.shared_day_id)]);
  const candidate=(days||[]).find((day)=>versions.get(day.id)?.boundary_state==="sealed"&&!used.has(day.id));
  if(!candidate)return;
  const result=await createDiaryJobForLatestVersion({userId,characterId,sharedDayId:candidate.id});
  if(result.created)startDiaryJob(result.job.id);
}

async function completedChatRequestResponse(request, userId) {
  const [{ data: assistant, error: assistantError }, { data: session, error: sessionError }] = await Promise.all([
    supabase.from("messages").select("id,content,generation_status,finish_reason,continues_message_id,recall_info").eq("id", request.assistant_message_id).maybeSingle(),
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
    recallInfo: assistant.recall_info || null,
    recovered: true,
  };
}

module.exports = {
  memoryCompressionsInFlight,
  compressMemoryInBackground,
  maybeCompressMemory,
  continueSourceIndexIfStarted,
  loadConfirmedDiaryForDay,
  rebuildSharedLifeDays,
  processDiaryGenerationJob,
  startDiaryJob,
  startDiaryJobsSequentially,
  createDiaryJobForLatestVersion,
  refreshSharedDaysAfterMarker,
  completedChatRequestResponse,
};
