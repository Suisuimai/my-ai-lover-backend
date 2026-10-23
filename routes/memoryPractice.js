const express = require("express");
const router = express.Router();
const { supabase } = require("../services/db");
const { getSettings, getOwnedCharacter, getOrCreateDefaultCharacter, getOrCreateUserProfile, loadPromptDocuments } = require("../services/data");
const { callModel, getModelTarget } = require("../services/model");
const { readAllOwnedSourceMessages } = require("../services/recall");
const { cleanClaudeSay } = require("../core/claudeImport");
const {
  buildExperienceExtractionPrompt,
  buildDocumentMergePrompt,
  buildImportDistillationPrompt,
  buildSupportExtractionPrompt,
  buildVerificationPrompt,
  parseExperienceExtraction,
  parseDocumentMerge,
  parseImportDistillation,
  parseMemoryVerification,
  parseSupportExtraction,
} = require("../core/memoryPractice");

router.post("/memory-practice/segments/:segmentId/extract", async (req, res) => {
  let batch;
  try {
    const { data: segment, error } = await supabase.from("imported_conversation_segments").select("*")
      .eq("id", req.params.segmentId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!segment) return res.status(404).json({ success: false, error: "Imported segment not found" });
    const settings = await getSettings(req.user.id);
    const [allDocuments, character, userProfile] = await Promise.all([
      loadPromptDocuments(req.user.id, segment.character_id),
      getOwnedCharacter(segment.character_id, req.user.id),
      getOrCreateUserProfile(req.user.id),
    ]);
    const documents = allDocuments.filter((document) => document.load_mode !== "archive");
    const identities = { characterName: character.name || "季疏", userName: userProfile.display_name || "年妤", userAliases: ["妤妤"] };
    const sourceMessages = (segment.raw_messages || []).map((message) => ({
      role: message.role,
      content: cleanClaudeSay(message.role, message.content),
    }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");

    async function extractPart({ prompt, parser, maxTokens }) {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const raw = await callModel({
          purpose: "long_term_memory_extraction",
          model: settings.summary_model,
          userId: req.user.id,
          temperature: 0.05,
          maxTokens,
          responseFormat: "json_object",
          thinking: "disabled",
          messages: [
            { role: "system", content: "You are a conservative documentary memory extractor. Follow the requested JSON schema exactly." },
            { role: "user", content: prompt },
            ...(attempt === 2 ? [{ role: "user", content: "The previous output was incomplete or failed strict validation. Return a shorter, complete JSON object and follow the schema exactly." }] : []),
          ],
        });
          return parser(raw, sourceMessages);
        } catch (extractionError) {
          lastError = extractionError;
        }
      }
      const failure = new Error("记忆模型连续两次没有返回完整、合格的结构化结果。请换一个更短的片段后重试。");
      failure.cause = lastError;
      throw failure;
    }
    const experiencePart = await extractPart({
      prompt: buildExperienceExtractionPrompt(numberedTranscript, segment.started_at, segment.ended_at, identities),
      parser: parseExperienceExtraction,
      maxTokens: 2200,
    });
    const supportPart = await extractPart({
      prompt: buildSupportExtractionPrompt(numberedTranscript, segment.started_at, segment.ended_at, documents, identities),
      parser: parseSupportExtraction,
      maxTokens: 2200,
    });
    const extraction = { experiences: experiencePart.experiences, knowledgeNotes: supportPart.knowledgeNotes, handoff: supportPart.handoff };

    const target = await getModelTarget({ userId: req.user.id, purpose: "long_term_memory_extraction", legacyModel: settings.summary_model });
    const { data: workspace, error: workspaceError } = await supabase.from("memory_import_workspaces").upsert({
      user_id: req.user.id, character_id: segment.character_id, import_id: segment.import_id, updated_at: new Date().toISOString(),
    }, { onConflict: "import_id" }).select().single();
    if (workspaceError) throw workspaceError;
    const { data: savedBatch, error: batchError } = await supabase.from("memory_processing_batches").upsert({
      user_id: req.user.id, character_id: segment.character_id, import_id: segment.import_id,
      segment_id: segment.id, workspace_id: workspace.id, status: "extracted",
      extraction_model: target.model, verification_model: null, verified_at: null,
    }, { onConflict: "segment_id" }).select().single();
    if (batchError) throw batchError;
    batch = savedBatch;

    await Promise.all([
      supabase.from("memory_experience_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_knowledge_notes").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_handoff_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id),
    ]);
    const experienceRows = extraction.experiences.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      title: item.title, narrative_markdown: item.narrativeMarkdown, current_state: item.currentState,
      index_summary: item.indexSummary, search_anchors: item.anchors, evidence_refs: item.evidence,
    }));
    const documentIds = new Set(documents.map((document) => document.id));
    const noteRows = extraction.knowledgeNotes.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      suggested_document_name: item.suggestedDocumentName, note_markdown: item.noteMarkdown, evidence_refs: item.evidence,
      target_document_id: documentIds.has(item.suggestedDocumentId) ? item.suggestedDocumentId : null,
    }));
    const handoffRows = extraction.handoff ? [{
      batch_id: batch.id, user_id: req.user.id, character_id: segment.character_id,
      body_markdown: extraction.handoff.bodyMarkdown, current_state: extraction.handoff.currentState,
      topics: extraction.handoff.topics, open_loops: extraction.handoff.openLoops,
      continuation_guidance: extraction.handoff.continuationGuidance, evidence_refs: extraction.handoff.evidence,
    }] : [];
    const [{ data: experiences, error: experienceError }, { data: notes, error: noteError }, { data: handoffs, error: handoffError }] = await Promise.all([
      experienceRows.length ? supabase.from("memory_experience_candidates").insert(experienceRows).select("*") : { data: [], error: null },
      noteRows.length ? supabase.from("memory_knowledge_notes").insert(noteRows).select("*") : { data: [], error: null },
      handoffRows.length ? supabase.from("memory_handoff_candidates").insert(handoffRows).select("*") : { data: [], error: null },
    ]);
    if (experienceError || noteError || handoffError) throw experienceError || noteError || handoffError;
    res.json({ success: true, batch, experiences: experiences || [], knowledgeNotes: notes || [], handoffs: handoffs || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.get("/memory-practice/batches", async (req, res) => {
  try {
    const { data, error } = await supabase.from("memory_processing_batches")
      .select("*, imported_conversation_segments(sequence,started_at,ended_at), memory_experience_candidates(*), memory_knowledge_notes(*), memory_handoff_candidates(*), memory_knowledge_patch_candidates(*)")
      .eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, batches: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/memory-practice/workspaces", async (req, res) => {
  try {
    const { data: workspaces, error: workspaceError } = await supabase.from("memory_import_workspaces")
      .select("*, conversation_imports(title,source_filename,message_count,segment_count,created_at)")
      .eq("user_id", req.user.id).order("updated_at", { ascending: false });
    if (workspaceError) throw workspaceError;
    const workspaceIds = (workspaces || []).map((workspace) => workspace.id);
    const characterIds = [...new Set((workspaces || []).map((workspace) => workspace.character_id))];
    const [{ data: batches, error: batchError }, { data: patches, error: patchError }, { data: documents, error: documentError }] = await Promise.all([
      workspaceIds.length ? supabase.from("memory_processing_batches").select("id,workspace_id,segment_id,memory_experience_candidates(id),memory_knowledge_notes(id,status,source_kind),memory_handoff_candidates(id)").in("workspace_id", workspaceIds).eq("user_id", req.user.id) : { data: [], error: null },
      workspaceIds.length ? supabase.from("memory_document_patch_candidates").select("*").in("workspace_id", workspaceIds).eq("user_id", req.user.id) : { data: [], error: null },
      characterIds.length ? supabase.from("prompt_documents").select("id,character_id,name,document_type,load_mode").in("character_id", characterIds).eq("user_id", req.user.id).neq("load_mode", "archive").order("sort_order") : { data: [], error: null },
    ]);
    if (batchError || patchError || documentError) throw batchError || patchError || documentError;
    const batchIds = (batches || []).map((batch) => batch.id);
    const { data: notes, error: noteError } = batchIds.length
      ? await supabase.from("memory_knowledge_notes").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted").order("created_at")
      : { data: [], error: null };
    if (noteError) throw noteError;
    res.json({
      success: true,
      documents: documents || [],
      workspaces: (workspaces || []).map((workspace) => {
        const workspaceBatches = (batches || []).filter((batch) => batch.workspace_id === workspace.id);
        const ids = new Set(workspaceBatches.map((batch) => batch.id));
        return {
          ...workspace,
          extractedSegmentCount: workspaceBatches.length,
          extractedSegmentIds: workspaceBatches.map((batch) => batch.segment_id),
          experienceCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_experience_candidates?.length || 0), 0),
          extractedNoteCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_knowledge_notes || []).filter((note) => note.status === "extracted").length, 0),
          handoffCount: workspaceBatches.reduce((sum, batch) => sum + (batch.memory_handoff_candidates?.length || 0), 0),
          segmentResults: workspaceBatches.map((batch) => ({
            segmentId: batch.segment_id,
            experienceCount: batch.memory_experience_candidates?.length || 0,
            noteCount: (batch.memory_knowledge_notes || []).filter((note) => note.source_kind === "segment_extraction" && note.status === "extracted").length,
            handoffCount: batch.memory_handoff_candidates?.length || 0,
          })),
          notes: (notes || []).filter((note) => ids.has(note.batch_id)),
          patches: (patches || []).filter((patch) => patch.workspace_id === workspace.id),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/memory-practice/workspaces/:workspaceId/distill", async (req, res) => {
  try {
    const { data: workspace, error } = await supabase.from("memory_import_workspaces").select("*")
      .eq("id", req.params.workspaceId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!workspace) return res.status(404).json({ success: false, error: "整份导入工作区不存在" });
    const { data: batches, error: batchError } = await supabase.from("memory_processing_batches").select("id,segment_id")
      .eq("workspace_id", workspace.id).eq("user_id", req.user.id);
    if (batchError) throw batchError;
    const batchIds = (batches || []).map((batch) => batch.id);
    if (!batchIds.length) return res.status(400).json({ success: false, error: "请先提取至少一个片段" });
    const [{ data: experiences, error: experienceError }, documents, character, userProfile] = await Promise.all([
      supabase.from("memory_experience_candidates").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).order("created_at"),
      loadPromptDocuments(req.user.id, workspace.character_id),
      getOwnedCharacter(workspace.character_id, req.user.id),
      getOrCreateUserProfile(req.user.id),
    ]);
    if (experienceError) throw experienceError;
    if (!experiences?.length) return res.status(400).json({ success: false, error: "已提取片段中还没有经历素材" });
    const activeDocuments = documents.filter((document) => document.load_mode !== "archive");
    const identities = { characterName: character.name || "季疏", userName: userProfile.display_name || "年妤", userAliases: ["妤妤"] };
    if (!activeDocuments.length) return res.status(400).json({ success: false, error: "请先创建至少一份可用的 Markdown 知识文件" });
    const batchById = new Map((batches || []).map((batch) => [batch.id, batch]));
    const experienceById = new Map(experiences.map((item) => [item.id, item]));
    const settings = await getSettings(req.user.id);
    const generated = [];
    for (let offset = 0; offset < experiences.length; offset += 20) {
      const group = experiences.slice(offset, offset + 20);
      const material = group.map((item) => ({
        id: item.id, segment_id: batchById.get(item.batch_id)?.segment_id,
        title: item.title, index_summary: item.index_summary, current_state: item.current_state,
        search_anchors: item.search_anchors,
        evidence: (item.evidence_refs || []).slice(0, 4).map((entry) => ({ role: entry.role, quote: String(entry.quote || "").slice(0, 600) })),
      }));
      const raw = await callModel({
        purpose: "memory_verification", model: settings.summary_model, userId: req.user.id,
        temperature: 0, maxTokens: 5000, responseFormat: "json_object", thinking: "disabled",
        messages: [
          { role: "system", content: "You conservatively distill grounded experiences into Chinese Knowledge File notes. Return complete JSON only." },
          { role: "user", content: buildImportDistillationPrompt({ experiences: material, documents: activeDocuments, identities }) },
        ],
      });
      generated.push(...parseImportDistillation(raw, group.map((item) => item.id), activeDocuments, identities));
    }
    const { error: deleteError } = await supabase.from("memory_knowledge_notes").delete()
      .in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted");
    if (deleteError) throw deleteError;
    const rows = generated.map((item) => {
      const sources = item.experienceIds.map((id) => experienceById.get(id)).filter(Boolean);
      const evidence = sources.flatMap((source) => (source.evidence_refs || []).map((entry) => ({
        ...entry, experienceId: source.id, experienceTitle: source.title, segmentId: batchById.get(source.batch_id)?.segment_id,
      }))).slice(0, 20);
      return {
        batch_id: sources[0].batch_id, user_id: req.user.id, character_id: workspace.character_id,
        suggested_document_name: item.suggestedDocumentName, note_markdown: item.noteMarkdown,
        target_document_id: item.suggestedDocumentId, evidence_refs: evidence,
        source_kind: "import_distillation", source_experience_ids: item.experienceIds,
      };
    });
    const { data: saved, error: saveError } = rows.length
      ? await supabase.from("memory_knowledge_notes").insert(rows).select("*")
      : { data: [], error: null };
    if (saveError) throw saveError;
    await supabase.from("memory_import_workspaces").update({ updated_at: new Date().toISOString() })
      .eq("id", workspace.id).eq("user_id", req.user.id);
    res.json({ success: true, notes: saved || [], experienceCount: experiences.length });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.patch("/memory-practice/notes/:noteId/target", async (req, res) => {
  try {
    const targetDocumentId = typeof req.body.targetDocumentId === "string" && req.body.targetDocumentId ? req.body.targetDocumentId : null;
    const { data: note, error } = await supabase.from("memory_knowledge_notes").select("id,character_id")
      .eq("id", req.params.noteId).eq("user_id", req.user.id).eq("status", "extracted").maybeSingle();
    if (error) throw error;
    if (!note) return res.status(404).json({ success: false, error: "Knowledge material not found" });
    if (targetDocumentId) {
      const { data: document, error: documentError } = await supabase.from("prompt_documents").select("id")
        .eq("id", targetDocumentId).eq("user_id", req.user.id).eq("character_id", note.character_id).neq("load_mode", "archive").maybeSingle();
      if (documentError) throw documentError;
      if (!document) return res.status(400).json({ success: false, error: "Choose an existing Knowledge File for this companion" });
    }
    const { data: saved, error: saveError } = await supabase.from("memory_knowledge_notes").update({ target_document_id: targetDocumentId })
      .eq("id", note.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    res.json({ success: true, note: saved });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/memory-practice/workspaces/:workspaceId/merge", async (req, res) => {
  try {
    const { data: workspace, error } = await supabase.from("memory_import_workspaces").select("*")
      .eq("id", req.params.workspaceId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!workspace) return res.status(404).json({ success: false, error: "Weekly memory workspace not found" });
    const { data: batches, error: batchError } = await supabase.from("memory_processing_batches").select("id,segment_id")
      .eq("workspace_id", workspace.id).eq("user_id", req.user.id);
    if (batchError) throw batchError;
    const batchIds = (batches || []).map((batch) => batch.id);
    const { data: notes, error: noteError } = batchIds.length
      ? await supabase.from("memory_knowledge_notes").select("*").in("batch_id", batchIds).eq("user_id", req.user.id).eq("status", "extracted").not("target_document_id", "is", null)
      : { data: [], error: null };
    if (noteError) throw noteError;
    if (!notes?.length) return res.status(400).json({ success: false, error: "请先把至少一条素材归入已有 Knowledge File" });
    const documentIds = [...new Set(notes.map((note) => note.target_document_id))];
    if (documentIds.length > 10) return res.status(400).json({ success: false, error: "一次最多合并 10 份 Knowledge File" });
    const { data: documents, error: documentError } = await supabase.from("prompt_documents").select("*")
      .in("id", documentIds).eq("user_id", req.user.id).eq("character_id", workspace.character_id).neq("load_mode", "archive");
    if (documentError) throw documentError;
    if ((documents || []).length !== documentIds.length) return res.status(400).json({ success: false, error: "部分目标 Knowledge File 已不存在或已归档" });
    const settings = await getSettings(req.user.id);
    const target = await getModelTarget({ userId: req.user.id, purpose: "memory_verification", legacyModel: settings.summary_model });
    const generated = [];
    for (const document of documents) {
      const routedNotes = notes.filter((note) => note.target_document_id === document.id);
      const routedBatchIds = new Set(routedNotes.map((note) => note.batch_id));
      const materialIds = routedNotes.map((_, index) => `N${index + 1}`);
      const prompt = buildDocumentMergePrompt({
        document, notes: routedNotes, mentionCount: routedNotes.length, segmentCount: routedBatchIds.size,
      });
      if (prompt.length > 140000) return res.status(400).json({ success: false, error: `"${document.name}"的本周素材过多，需要先分批压缩` });
      const raw = await callModel({
        purpose: "memory_verification", model: settings.summary_model, userId: req.user.id,
        temperature: 0, maxTokens: 9000, responseFormat: "json_object", thinking: "disabled",
        messages: [
          { role: "system", content: "You are a conservative editor of one user-maintained Knowledge File. Return complete JSON only." },
          { role: "user", content: prompt },
        ],
      });
      const merged = parseDocumentMerge(raw, materialIds);
      if (merged.proposedContent === document.content.trim()) continue;
      const sourceNoteIds = merged.usedMaterialIds.map((id) => routedNotes[Number(id.slice(1)) - 1]?.id).filter(Boolean);
      const { data: saved, error: saveError } = await supabase.from("memory_document_patch_candidates").upsert({
        workspace_id: workspace.id, user_id: req.user.id, character_id: workspace.character_id,
        document_id: document.id, document_name: document.name, previous_content: document.content,
        proposed_content: merged.proposedContent, change_summary: merged.changeSummary, merge_reason: merged.why,
        source_note_ids: sourceNoteIds, mention_count: routedNotes.length, segment_count: routedBatchIds.size,
        review_status: "suggested", reviewed_at: null,
      }, { onConflict: "workspace_id,document_id" }).select().single();
      if (saveError) throw saveError;
      generated.push(saved);
    }
    const { error: workspaceError } = await supabase.from("memory_import_workspaces").update({
      status: "review", updated_at: new Date().toISOString(),
    }).eq("id", workspace.id).eq("user_id", req.user.id);
    if (workspaceError) throw workspaceError;
    res.json({ success: true, patches: generated, model: target.model });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/memory-practice/document-patches/:patchId/confirm", async (req, res) => {
  try {
    const { data: patch, error } = await supabase.from("memory_document_patch_candidates").select("*")
      .eq("id", req.params.patchId).eq("user_id", req.user.id).eq("review_status", "suggested").maybeSingle();
    if (error) throw error;
    if (!patch) return res.status(404).json({ success: false, error: "Suggested document change not found" });
    const { data: document, error: documentError } = await supabase.from("prompt_documents").select("*")
      .eq("id", patch.document_id).eq("user_id", req.user.id).eq("character_id", patch.character_id).maybeSingle();
    if (documentError) throw documentError;
    if (!document) return res.status(404).json({ success: false, error: "Target Knowledge File no longer exists" });
    if (document.content !== patch.previous_content) {
      return res.status(409).json({ success: false, error: "这份 Knowledge File 在预览生成后被修改过。请重新生成合并预览，系统不会覆盖较新的内容。" });
    }
    const { data: savedDocument, error: saveError } = await supabase.from("prompt_documents").update({
      content: patch.proposed_content, confirmation_status: "confirmed", updated_at: new Date().toISOString(),
    }).eq("id", document.id).eq("user_id", req.user.id).select().single();
    if (saveError) throw saveError;
    const { data: reviewed, error: reviewError } = await supabase.from("memory_document_patch_candidates").update({
      review_status: "confirmed", reviewed_at: new Date().toISOString(),
    }).eq("id", patch.id).eq("user_id", req.user.id).select().single();
    if (reviewError) throw reviewError;
    if (patch.source_note_ids?.length) {
      const { error: noteError } = await supabase.from("memory_knowledge_notes").update({ status: "merged" })
        .in("id", patch.source_note_ids).eq("user_id", req.user.id);
      if (noteError) throw noteError;
    }
    const { count, error: countError } = await supabase.from("memory_document_patch_candidates")
      .select("id", { count: "exact", head: true }).eq("workspace_id", patch.workspace_id).eq("user_id", req.user.id).eq("review_status", "suggested");
    if (countError) throw countError;
    if (!count) await supabase.from("memory_import_workspaces").update({ status: "applied", updated_at: new Date().toISOString() })
      .eq("id", patch.workspace_id).eq("user_id", req.user.id);
    res.json({ success: true, patch: reviewed, document: savedDocument });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post("/memory-practice/document-patches/:patchId/reject", async (req, res) => {
  const { data, error } = await supabase.from("memory_document_patch_candidates").update({
    review_status: "rejected", reviewed_at: new Date().toISOString(),
  }).eq("id", req.params.patchId).eq("user_id", req.user.id).eq("review_status", "suggested").select().maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "Suggested document change not found" });
  res.json({ success: true, patch: data });
});

router.post("/memory-practice/batches/:batchId/verify", async (req, res) => {
  try {
    const { data: batch, error } = await supabase.from("memory_processing_batches").select("*")
      .eq("id", req.params.batchId).eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!batch) return res.status(404).json({ success: false, error: "Memory batch not found" });
    const [{ data: segment, error: segmentError }, { data: experiences, error: experienceError }, { data: notes, error: noteError }] = await Promise.all([
      supabase.from("imported_conversation_segments").select("*").eq("id", batch.segment_id).eq("user_id", req.user.id).maybeSingle(),
      supabase.from("memory_experience_candidates").select("*").eq("batch_id", batch.id).eq("user_id", req.user.id),
      supabase.from("memory_knowledge_notes").select("*").eq("batch_id", batch.id).eq("user_id", req.user.id),
    ]);
    if (segmentError || experienceError || noteError) throw segmentError || experienceError || noteError;
    if (!segment) throw new Error("The source segment for this batch no longer exists");
    const documents = await loadPromptDocuments(req.user.id, batch.character_id);
    const suggestedNames = (notes || []).map((item) => item.suggested_document_name.trim().toLocaleLowerCase());
    const relevantDocuments = documents.filter((document) => suggestedNames.some((name) => {
      const documentName = document.name.trim().toLocaleLowerCase();
      return name.includes(documentName) || documentName.includes(name);
    })).slice(0, 5);
    const sourceMessages = (segment.raw_messages || []).map((message) => ({ role: message.role, content: cleanClaudeSay(message.role, message.content) }));
    const numberedTranscript = sourceMessages.map((message, index) =>
      `[M${index + 1}] ${message.role === "user" ? "User" : "Companion"}: ${message.content}`).join("\n\n");
    const settings = await getSettings(req.user.id);
    const raw = await callModel({
      purpose: "memory_verification", model: settings.summary_model, userId: req.user.id,
      temperature: 0, maxTokens: 7000, responseFormat: "json_object", thinking: "disabled",
      messages: [
        { role: "system", content: "You are a strict documentary fact checker and knowledge-file editor. Return JSON only." },
        { role: "user", content: buildVerificationPrompt({ numberedTranscript, experiences: experiences || [], knowledgeNotes: notes || [], documents: relevantDocuments }) },
      ],
    });
    const verification = parseMemoryVerification(raw, sourceMessages, (experiences || []).map((item) => item.id), relevantDocuments);
    await supabase.from("memory_knowledge_patch_candidates").delete().eq("batch_id", batch.id).eq("user_id", req.user.id).eq("review_status", "suggested");
    for (const review of verification.experienceReviews) {
      const { error: updateError } = await supabase.from("memory_experience_candidates").update({ verification_status: review.verdict, verification_notes: review.correctionReason })
        .eq("id", review.candidateId).eq("batch_id", batch.id).eq("user_id", req.user.id);
      if (updateError) throw updateError;
    }
    const patchRows = verification.knowledgePatches.map((item) => ({
      batch_id: batch.id, user_id: req.user.id, character_id: batch.character_id,
      document_id: item.documentId, document_name: item.documentName, previous_content: item.previousContent,
      proposed_content: item.proposedContent, change_summary: item.changeSummary, evidence_refs: item.evidence,
    }));
    const { data: patches, error: patchError } = patchRows.length
      ? await supabase.from("memory_knowledge_patch_candidates").insert(patchRows).select("*")
      : { data: [], error: null };
    if (patchError) throw patchError;
    const target = await getModelTarget({ userId: req.user.id, purpose: "memory_verification", legacyModel: settings.summary_model });
    const { data: savedBatch, error: batchError } = await supabase.from("memory_processing_batches").update({
      status: "verified", verification_model: target.model, verified_at: new Date().toISOString(),
    }).eq("id", batch.id).eq("user_id", req.user.id).select().single();
    if (batchError) throw batchError;
    res.json({ success: true, batch: savedBatch, patches: patches || [], experienceReviews: verification.experienceReviews });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
