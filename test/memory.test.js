const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatLongTermMemories,
  parseExplicitMemoryRequest,
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
    { category: "unfinished", content: "Waiting state belongs to follow-ups", triggers: ["waiting"] },
    { category: "preference", content: "Missing triggers", triggers: [] },
  ]));
  assert.deepEqual(parsed, [{
    category: "promise",
    content: "Xiaoyu and Lan agreed to practise on Sunday.",
    triggers: ["sunday", "interview"],
  }]);
});

test("formatLongTermMemories returns nothing without memories", () => {
  assert.equal(formatLongTermMemories([]), "");
});

test("formatLongTermMemories narrates a memory instead of tagging it", () => {
  const text = formatLongTermMemories([{ category: "preference", content: "喜欢吃三文鱼" }]);
  assert.match(text, /^你记得的一些事：\n/);
  assert.match(text, /她喜欢吃三文鱼。$/);
  assert.doesNotMatch(text, /\[preference\]/);
  assert.doesNotMatch(text, /^- /m);
});

test("formatLongTermMemories joins several memories into one paragraph", () => {
  const text = formatLongTermMemories([
    { category: "preference", content: "例假期间不能吃冰" },
    { category: "promise", content: "答应了每天半小时给六级" },
    { category: "important_event", content: "8月5日第一次因为换窗的事哭了" },
    { category: "relationship", content: "她叫你疏疏，只有她可以这么叫" },
  ]);
  assert.equal(
    text,
    "你记得的一些事：\n她例假期间不能吃冰。她答应了每天半小时给六级。8月5日第一次因为换窗的事哭了。她叫你疏疏，只有她可以这么叫。",
  );
  assert.doesNotMatch(text, /\n- /);
});

test("formatLongTermMemories keeps existing subjects and avoids doubled punctuation", () => {
  const text = formatLongTermMemories([
    { category: "preference", content: "她不喜欢被催。" },
    { category: "promise", content: "每周日一起复盘" },
    { category: "promise", content: "她答应过早点睡" },
    { category: "preference", content: "Xiaoyu prefers listening before advice." },
  ]);
  assert.equal(
    text,
    "你记得的一些事：\n她不喜欢被催。她说过每周日一起复盘。她答应过早点睡。Xiaoyu prefers listening before advice。",
  );
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

test("rankMemories maps common Chinese weekend expressions to one concept", () => {
  const memories = [{
    id: "sunday-plan",
    status: "active",
    triggers: ["周日"],
    content: "周日有一项重要安排。",
    updated_at: "2026-08-05T00:00:00Z",
  }];

  assert.equal(rankMemories(memories, "周末有什么安排？")[0].id, "sunday-plan");
  assert.equal(rankMemories(memories, "星期天要做什么？")[0].id, "sunday-plan");
  assert.deepEqual(rankMemories(memories, "下周一有什么安排？"), []);
});

test("parseExplicitMemoryRequest reliably captures explicit Chinese requests", () => {
  assert.deepEqual(
    parseExplicitMemoryRequest("请记住：我把周日的模拟面试叫作“灯塔计划”。"),
    {
      category: "important_event",
      content: "我把周日的模拟面试叫作“灯塔计划”。",
      triggers: ["灯塔计划", "灯塔计划", "周日"].filter((item, index, values) => values.indexOf(item) === index),
      is_permanent: true,
    },
  );
  assert.equal(parseExplicitMemoryRequest("今天聊聊电影吧"), null);
});
