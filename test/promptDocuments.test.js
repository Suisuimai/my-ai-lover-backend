const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPromptDocuments, selectRelevantPromptDocuments } = require("../core/promptDocuments");

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

test("always-loaded documents exclude on-demand, archived, and suggested content", () => {
  const output = formatPromptDocuments([
    { name:"Core", content:"always", is_enabled:true, load_mode:"always", confirmation_status:"confirmed", sort_order:0 },
    { name:"Topic", content:"on demand", is_enabled:true, load_mode:"on_demand", confirmation_status:"confirmed", sort_order:1 },
    { name:"Draft", content:"unconfirmed", is_enabled:true, load_mode:"always", confirmation_status:"suggested", sort_order:2 },
  ]);
  assert.match(output, /always/);
  assert.doesNotMatch(output, /on demand|unconfirmed/);
});

test("on-demand selection requires a matching term", () => {
  const documents = [
    { id:"trip", name:"秋季旅行", content:"我们打算看红叶", is_enabled:true, load_mode:"on_demand", confirmation_status:"confirmed", sort_order:0 },
    { id:"food", name:"食物", content:"喜欢甜点", is_enabled:true, load_mode:"on_demand", confirmation_status:"confirmed", sort_order:1 },
  ];
  assert.deepEqual(selectRelevantPromptDocuments(documents, "秋季旅行看红叶", 2).map((item) => item.id), ["trip"]);
});
