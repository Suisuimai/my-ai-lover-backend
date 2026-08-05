const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatLongTermMemories,
  parseMemoryExtraction,
  rankMemories,
  splitTriggers,
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

test("splitTriggers accepts Chinese and Western separators and removes duplicates", () => {
  assert.deepEqual(
    splitTriggers(["灯塔计划、模拟面试，周日", "周日; interview\n灯塔计划"]),
    ["灯塔计划", "模拟面试", "周日", "interview"],
  );
});

test("rankMemories supports partial Chinese trigger and content overlap", () => {
  const memories = [{
    id: "lighthouse",
    status: "active",
    triggers: ["灯塔计划、模拟面试、周日"],
    content: "用户把周日的模拟面试称为灯塔计划，希望先询问准备情况。",
    updated_at: "2026-08-05T00:00:00Z",
  }];

  assert.equal(rankMemories(memories, "我们聊聊灯塔计划吧")[0].id, "lighthouse");
  assert.equal(rankMemories(memories, "周末那个面试安排怎么样了")[0].id, "lighthouse");
  assert.deepEqual(rankMemories(memories, "今天晚饭吃什么"), []);
});
