const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_CONTENT = 30000;
const DOCUMENT_TYPES = new Set(["core", "memory_protocol", "topic", "archive"]);
const LOAD_MODES = new Set(["always", "on_demand", "archive"]);
const CONFIRMATION_STATUSES = new Set(["confirmed", "suggested"]);

function formatPromptDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length) return "";
  const sections = documents
    .filter((document) => document
      && document.is_enabled
      && (!document.load_mode || document.load_mode === "always")
      && document.confirmation_status !== "suggested"
      && document.content?.trim())
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((document) => `## ${document.name}\n${document.content.trim()}`);
  if (!sections.length) return "";
  return [
    "User-authored prompt documents (apply in the listed order):",
    ...sections,
  ].join("\n\n");
}

function selectRelevantPromptDocuments(documents, currentMessage, limit = 3) {
  const message = String(currentMessage || "").trim().toLocaleLowerCase();
  if (!message) return [];
  const terms = new Set(message.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2}/giu) || []);
  return documents
    .filter((document) => document?.load_mode === "on_demand"
      && document.is_enabled
      && document.confirmation_status !== "suggested")
    .map((document) => {
      const haystack = `${document.name}\n${document.content}`.toLocaleLowerCase();
      const score = [...terms].reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { document, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || left.document.sort_order - right.document.sort_order)
    .slice(0, Math.max(0, limit))
    .map(({ document }) => document);
}

function formatRetrievedPromptDocuments(documents) {
  if (!documents.length) return "";
  return [
    "Relevant user-maintained knowledge files (background, not new user messages):",
    ...documents.map((document) => `## ${document.name}\n${document.content.trim()}`),
  ].join("\n\n");
}

module.exports = {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_CONTENT,
  DOCUMENT_TYPES,
  LOAD_MODES,
  CONFIRMATION_STATUSES,
  formatPromptDocuments,
  formatRetrievedPromptDocuments,
  selectRelevantPromptDocuments,
};
