const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_CONTENT = 30000;

function formatPromptDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length) return "";
  const sections = documents
    .filter((document) => document && document.is_enabled && document.content?.trim())
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((document) => `## ${document.name}\n${document.content.trim()}`);
  if (!sections.length) return "";
  return [
    "User-authored prompt documents (apply in the listed order):",
    ...sections,
  ].join("\n\n");
}

module.exports = {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_CONTENT,
  formatPromptDocuments,
};
