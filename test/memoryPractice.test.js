const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildExperienceExtractionPrompt, buildExtractionPrompt, buildSupportExtractionPrompt,
  buildDocumentMergePrompt, buildVerificationPrompt, parseDocumentMerge, parseMemoryExtraction,
  parseMemoryVerification, stripTransientCitations,
} = require("../core/memoryPractice");

const source = [
  { role: "user", content: "秋季旅行还不确定，我们一周后再讨论。" },
  { role: "assistant", content: "好，我先不催你，下周再一起看看。" },
];

test("parses grounded experiences with structured search anchors", () => {
  const result = parseMemoryExtraction(JSON.stringify({
    experiences: [{
      title: " sweets ", narrative_markdown: "正文", current_state: "等待下周讨论", index_summary: "旅行尚未确定",
      evidence_message_numbers: [1, 2],
      search_anchors: { people_places: [], event_names: ["秋季旅行"], key_objects: [], special_phrases: ["一周后再讨论"], synonyms: ["秋天出游", "下周谈旅行"], final_state_terms: ["待讨论"] },
    }], knowledge_notes: [], handoff: null,
  }), source);
  assert.equal(result.experiences[0].title, "sweets");
  assert.equal(result.experiences[0].evidence[0].quote, source[0].content);
  assert.equal(result.experiences[0].anchors.synonyms.length, 2);
});

test("rejects weak anchors and invalid citations", () => {
  const base = { title: "x", narrative_markdown: "x", current_state: "x", index_summary: "x", evidence_message_numbers: [1], search_anchors: { event_names: ["旅行"], synonyms: ["出游"], final_state_terms: ["待定"] } };
  assert.throws(() => parseMemoryExtraction(JSON.stringify({ experiences: [base] }), source), /at least two/);
  base.search_anchors.synonyms = ["出游", "旅行安排"];
  base.evidence_message_numbers = [3];
  assert.throws(() => parseMemoryExtraction(JSON.stringify({ experiences: [base] }), source), /valid source/);
});

test("extraction prompt requires the evidence grid", () => {
  const prompt = buildExtractionPrompt("[M1] User: hello", "start", "end");
  assert.match(prompt, /people_places/);
  assert.match(prompt, /synonyms must contain at least 2/);
  assert.match(prompt, /evidence_message_numbers/);
});

test("split extraction prompts keep large outputs in separate JSON objects", () => {
  const experiences = buildExperienceExtractionPrompt("[M1] User: hi", "start", "end");
  const support = buildSupportExtractionPrompt("[M1] User: hi", "start", "end");
  assert.match(experiences, /Do not return knowledge_notes or handoff/);
  assert.match(support, /Do not return experiences/);
  assert.match(experiences, /0-3 experiences/);
});

test("verification requires every experience and grounded knowledge patches", () => {
  const result = parseMemoryVerification(JSON.stringify({
    experience_reviews: [{ candidate_id: "e1", verdict: "verified", correction_reason: "" }],
    knowledge_patches: [{ document_id: "d1", document_name: "ignored", change_summary: "补充旅行安排", proposed_content: "# 旅行\n一周后讨论。", evidence_message_numbers: [1] }],
  }), source, ["e1"], [{ id: "d1", name: "旅行", content: "# 旅行" }]);
  assert.equal(result.knowledgePatches[0].documentName, "旅行");
  assert.equal(result.knowledgePatches[0].previousContent, "# 旅行");
  assert.throws(() => parseMemoryVerification(JSON.stringify({ experience_reviews: [], knowledge_patches: [] }), source, ["e1"], []), /every extracted/);
});

test("verification prompt contains source, candidates, and existing files", () => {
  const prompt = buildVerificationPrompt({ numberedTranscript: "[M1] User: hi", experiences: [{ id: "e1" }], knowledgeNotes: [], documents: [{ id: "d1", name: "秘密", content: "x" }] });
  assert.match(prompt, /EXTRACTED EXPERIENCES/);
  assert.match(prompt, /EXISTING KNOWLEDGE FILES/);
  assert.match(prompt, /SOURCE MESSAGES/);
});

test("removes temporary message citations from durable Markdown", () => {
  assert.equal(stripTransientCitations("事实。[M12][S2-M4]\n下一行"), "事实。\n下一行");
});

test("builds and parses one-document weekly merges", () => {
  const prompt = buildDocumentMergePrompt({ document: { name: "亲密手册", content: "# 旧内容" }, notes: [], mentionCount: 3, segmentCount: 2 });
  assert.match(prompt, /exactly one existing Knowledge File/);
  assert.match(prompt, /3 routed notes across 2/);
  const parsed = parseDocumentMerge(JSON.stringify({ change_summary: "补充约定", why: "两段对话重复确认", proposed_content: "# 新内容\n约定。[M2]", used_material_ids: ["N1"] }), ["N1"]);
  assert.equal(parsed.proposedContent, "# 新内容\n约定。");
  assert.throws(() => parseDocumentMerge(JSON.stringify({ change_summary: "x", why: "充分理由", proposed_content: "x", used_material_ids: ["N2"] }), ["N1"]), /unknown/);
  assert.throws(() => parseDocumentMerge(JSON.stringify({ change_summary: "x", why: "充分理由", proposed_content: "x", used_material_ids: [] }), ["N1"]), /did not use/);
});
