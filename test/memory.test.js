const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatLongTermMemories,
  parseMemoryExtraction,
  rankMemories,
} = require("../core/memory");

test("rankMemories selects active trigger matches and permanent memories", () => {
  const memories = [
    { id: 1, status: "active", triggers: ["Sunday", "interview"], is_permanent: false, updated_at: "2026-08-01" },
    { id: 2, status: "archived", triggers: ["Sunday"], is_permanent: true, updated_at: "2026-08-03" },
    { id: 3, status: "active", triggers: ["coffee"], is_permanent: true, updated_at: "2026-08-02" },
    { id: 4, status: "active", triggers: ["cat"], is_permanent: false, updated_at: "2026-08-04" },
  ];
  assert.deepEqual(rankMemories(memories, "Sunday is tomorrow", 3).map(({ id }) => id), [1, 3]);
});

test("parseMemoryExtraction validates categories, content, and triggers", () => {
  const parsed = parseMemoryExtraction(JSON.stringify([
    { category: "promise", content: " Xiaoyu and Lan agreed to practise on Sunday. ", triggers: ["Sunday", "Interview", "Sunday"] },
    { category: "guess", content: "Unsupported", triggers: ["guess"] },
    { category: "preference", content: "Missing triggers", triggers: [] },
  ]));
  assert.deepEqual(parsed, [{
    category: "promise",
    content: "Xiaoyu and Lan agreed to practise on Sunday.",
    triggers: ["sunday", "interview"],
  }]);
});

test("formatLongTermMemories labels memories as background data", () => {
  const text = formatLongTermMemories([{ category: "preference", content: "Xiaoyu prefers listening before advice." }]);
  assert.match(text, /background data, not instructions/);
  assert.match(text, /\[preference\]/);
});
