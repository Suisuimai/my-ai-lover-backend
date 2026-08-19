const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPromptDocuments } = require("../core/promptDocuments");

test("formatPromptDocuments keeps enabled documents in explicit order", () => {
  assert.equal(formatPromptDocuments([
    { name: "Second", content: "B", sort_order: 2, is_enabled: true },
    { name: "Disabled", content: "Hidden", sort_order: 0, is_enabled: false },
    { name: "First", content: "A", sort_order: 1, is_enabled: true },
  ]), [
    "User-authored prompt documents (apply in the listed order):",
    "## First\nA",
    "## Second\nB",
  ].join("\n\n"));
});

test("formatPromptDocuments omits empty input", () => {
  assert.equal(formatPromptDocuments([]), "");
});
