const ANCHOR_FIELDS = [
  "people_places", "event_names", "key_objects", "special_phrases", "synonyms", "final_state_terms",
];

function uniqueStrings(value, limit = 12, maxLength = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, limit).map((item) => item.slice(0, maxLength));
}

function parseJsonObject(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Memory model did not return JSON");
  return JSON.parse(match[0]);
}

function evidenceFromNumbers(numbers, sourceMessages, limit = 8) {
  const normalized = [...new Set((Array.isArray(numbers) ? numbers : []).filter(Number.isInteger))].slice(0, limit);
  if (!normalized.length || normalized.some((number) => number < 1 || number > sourceMessages.length)) {
    throw new Error("Every memory candidate must cite valid source message numbers");
  }
  return normalized.map((number) => ({
    messageNumber: number,
    role: sourceMessages[number - 1].role,
    quote: String(sourceMessages[number - 1].content || "").trim().slice(0, 2000),
  }));
}

function normalizeAnchors(value) {
  const anchors = Object.fromEntries(ANCHOR_FIELDS.map((field) => [field, uniqueStrings(value?.[field])]));
  if (anchors.synonyms.length < 2) {
    throw new Error("Every experience needs at least two common alternative search phrases");
  }
  if (!["people_places", "event_names", "key_objects", "special_phrases"].some((field) => anchors[field].length)) {
    throw new Error("Every experience needs at least one concrete person, place, event, object, or special phrase");
  }
  if (!anchors.final_state_terms.length) throw new Error("Every experience needs final-state search terms");
  return anchors;
}

function parseMemoryExtraction(raw, sourceMessages) {
  const parsed = parseJsonObject(raw);
  const experiences = (Array.isArray(parsed.experiences) ? parsed.experiences : []).slice(0, 5).map((item) => {
    if (!item.title || !item.narrative_markdown || !item.current_state || !item.index_summary) {
      throw new Error("An experience is missing required documentary fields");
    }
    return {
      title: String(item.title).trim().slice(0, 160),
      narrativeMarkdown: String(item.narrative_markdown).trim().slice(0, 20000),
      currentState: String(item.current_state).trim().slice(0, 3000),
      indexSummary: String(item.index_summary).trim().slice(0, 1200),
      anchors: normalizeAnchors(item.search_anchors),
      evidence: evidenceFromNumbers(item.evidence_message_numbers, sourceMessages),
    };
  });
  const knowledgeNotes = (Array.isArray(parsed.knowledge_notes) ? parsed.knowledge_notes : []).slice(0, 6).map((item) => ({
    suggestedDocumentName: String(item.suggested_document_name || "").trim().slice(0, 120),
    noteMarkdown: String(item.note_markdown || "").trim().slice(0, 6000),
    evidence: evidenceFromNumbers(item.evidence_message_numbers, sourceMessages),
  })).filter((item) => item.suggestedDocumentName && item.noteMarkdown);
  const handoff = parsed.handoff && parsed.handoff.body_markdown ? {
    bodyMarkdown: String(parsed.handoff.body_markdown).trim().slice(0, 12000),
    currentState: String(parsed.handoff.current_state || "").trim().slice(0, 3000),
    topics: uniqueStrings(parsed.handoff.topics, 20, 200),
    openLoops: uniqueStrings(parsed.handoff.open_loops, 20, 300),
    continuationGuidance: String(parsed.handoff.continuation_guidance || "").trim().slice(0, 3000),
    evidence: evidenceFromNumbers(parsed.handoff.evidence_message_numbers, sourceMessages),
  } : null;
  return { experiences, knowledgeNotes, handoff };
}

function parseExperienceExtraction(raw, sourceMessages) {
  const extraction = parseMemoryExtraction(raw, sourceMessages);
  return { experiences: extraction.experiences, knowledgeNotes: [], handoff: null };
}

function parseSupportExtraction(raw, sourceMessages) {
  const extraction = parseMemoryExtraction(raw, sourceMessages);
  return { experiences: [], knowledgeNotes: extraction.knowledgeNotes, handoff: extraction.handoff };
}

function buildExtractionPrompt(numberedTranscript, startedAt, endedAt) {
  return [
    "Extract grounded memory material from an AI-companion conversation. Return JSON only.",
    "Do not merge or polish an existing knowledge file. Do not invent causes, feelings, decisions, or outcomes.",
    "Every claim must cite evidence_message_numbers. The server will replace citations with the complete original messages.",
    "An experience search_anchors must fill these arrays: people_places, event_names, key_objects, special_phrases, synonyms, final_state_terms.",
    "synonyms must contain at least 2 genuinely useful alternative ways the user may later refer to the same event.",
    "Schema:",
    JSON.stringify({
      experiences: [{ title: "", narrative_markdown: "", current_state: "", index_summary: "", evidence_message_numbers: [1], search_anchors: Object.fromEntries(ANCHOR_FIELDS.map((field) => [field, [""]])) }],
      knowledge_notes: [{ suggested_document_name: "", note_markdown: "", evidence_message_numbers: [1] }],
      handoff: { body_markdown: "", current_state: "", topics: [""], open_loops: [""], continuation_guidance: "", evidence_message_numbers: [1] },
    }),
    `Segment time: ${startedAt} to ${endedAt}`,
    numberedTranscript,
  ].join("\n\n");
}

function buildExperienceExtractionPrompt(numberedTranscript, startedAt, endedAt) {
  return [
    "Extract only grounded dated experiences from an AI-companion conversation. Return JSON only.",
    "Return 0-3 experiences. Do not return knowledge_notes or handoff.",
    "Do not invent causes, feelings, decisions, or outcomes. Every factual claim must cite evidence_message_numbers.",
    "Each search_anchors object must contain arrays named people_places, event_names, key_objects, special_phrases, synonyms, final_state_terms.",
    "synonyms must contain at least 2 useful alternative ways the user may later refer to the same event.",
    `Schema: ${JSON.stringify({ experiences: [{ title: "", narrative_markdown: "", current_state: "", index_summary: "", evidence_message_numbers: [1], search_anchors: Object.fromEntries(ANCHOR_FIELDS.map((field) => [field, [""]])) }] })}`,
    `Segment time: ${startedAt} to ${endedAt}`,
    numberedTranscript,
  ].join("\n\n");
}

function buildSupportExtractionPrompt(numberedTranscript, startedAt, endedAt) {
  return [
    "Extract only Knowledge File notes and window-handoff material from an AI-companion conversation. Return JSON only.",
    "Do not return experiences. Create 0-4 concise knowledge notes. Do not rewrite a complete knowledge file.",
    "Every note and handoff must cite evidence_message_numbers. Do not invent feelings, decisions, or outcomes.",
    `Schema: ${JSON.stringify({ knowledge_notes: [{ suggested_document_name: "", note_markdown: "", evidence_message_numbers: [1] }], handoff: { body_markdown: "", current_state: "", topics: [""], open_loops: [""], continuation_guidance: "", evidence_message_numbers: [1] } })}`,
    `Segment time: ${startedAt} to ${endedAt}`,
    numberedTranscript,
  ].join("\n\n");
}

function parseMemoryVerification(raw, sourceMessages, allowedExperienceIds, documents) {
  const parsed = parseJsonObject(raw);
  const allowedIds = new Set(allowedExperienceIds);
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const experienceReviews = (Array.isArray(parsed.experience_reviews) ? parsed.experience_reviews : []).map((item) => {
    if (!allowedIds.has(item.candidate_id) || !["verified", "needs_revision"].includes(item.verdict)) {
      throw new Error("Verification returned an unknown experience or verdict");
    }
    return {
      candidateId: item.candidate_id,
      verdict: item.verdict,
      correctionReason: String(item.correction_reason || "").trim().slice(0, 2000),
    };
  });
  if (experienceReviews.length !== allowedIds.size || new Set(experienceReviews.map((item) => item.candidateId)).size !== allowedIds.size) {
    throw new Error("Verification must review every extracted experience exactly once");
  }
  const knowledgePatches = (Array.isArray(parsed.knowledge_patches) ? parsed.knowledge_patches : []).slice(0, 6).map((item) => {
    const documentId = item.document_id || null;
    if (documentId && !documentMap.has(documentId)) throw new Error("Verification referenced an unknown knowledge file");
    const existing = documentId ? documentMap.get(documentId) : null;
    const name = String(existing?.name || item.document_name || "").trim().slice(0, 120);
    const proposedContent = String(item.proposed_content || "").trim().slice(0, 30000);
    const changeSummary = String(item.change_summary || "").trim().slice(0, 2000);
    if (!name || !proposedContent || !changeSummary) throw new Error("A knowledge-file patch is incomplete");
    return {
      documentId, documentName: name, previousContent: existing?.content || "", proposedContent, changeSummary,
      evidence: evidenceFromNumbers(item.evidence_message_numbers, sourceMessages),
    };
  });
  return { experienceReviews, knowledgePatches };
}

function buildVerificationPrompt({ numberedTranscript, experiences, knowledgeNotes, documents }) {
  return [
    "Verify extracted companion-memory material against the numbered source messages, then propose knowledge-file patches. Return JSON only.",
    "Mark every experience verified only if its narrative, current state, and index summary are fully supported. Otherwise mark needs_revision and explain the distortion.",
    "For knowledge patches, return the complete proposed Markdown content. Preserve supported existing material; add only facts supported by cited message numbers.",
    "Prefer updating a matching existing document_id. Use null only when a genuinely new thematic file is needed.",
    "Schema: {\"experience_reviews\":[{\"candidate_id\":\"\",\"verdict\":\"verified|needs_revision\",\"correction_reason\":\"\"}],\"knowledge_patches\":[{\"document_id\":null,\"document_name\":\"\",\"change_summary\":\"\",\"proposed_content\":\"\",\"evidence_message_numbers\":[1]}]}",
    `EXTRACTED EXPERIENCES:\n${JSON.stringify(experiences)}`,
    `EXTRACTED KNOWLEDGE NOTES:\n${JSON.stringify(knowledgeNotes)}`,
    `EXISTING KNOWLEDGE FILES:\n${JSON.stringify(documents.map(({ id, name, content }) => ({ id, name, content })))}`,
    `SOURCE MESSAGES:\n${numberedTranscript}`,
  ].join("\n\n");
}

module.exports = {
  ANCHOR_FIELDS, buildExperienceExtractionPrompt, buildExtractionPrompt, buildSupportExtractionPrompt,
  buildVerificationPrompt, normalizeAnchors, parseExperienceExtraction, parseMemoryExtraction,
  parseMemoryVerification, parseSupportExtraction,
};
