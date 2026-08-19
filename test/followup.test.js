const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatFollowUps,
  parseExplicitFollowUpRequest,
  selectRelevantFollowUps,
  selectStatusRelevantFollowUps,
  selectContextualFollowUps,
  suggestFollowUpStatus,
} = require("../core/followup");

test("parseExplicitFollowUpRequest captures an explicitly requested follow-up", () => {
  const parsed = parseExplicitFollowUpRequest("灯塔计划周日结束后，记得问问我“灯塔计划”怎么样了。");
  assert.equal(parsed.title, "灯塔计划");
  assert.equal(parsed.allow_proactive, true);
  assert.deepEqual(parsed.triggers, ["灯塔计划", "周日"]);
  assert.equal(parseExplicitFollowUpRequest("我周日可能看看电影。"), null);
});

test("selectRelevantFollowUps ignores completed and unrelated items", () => {
  const rows = [
    { id: 1, title: "灯塔计划", content: "周日模拟面试", triggers: ["灯塔计划", "面试"], status: "active" },
    { id: 2, title: "旧计划", content: "已经完成", triggers: ["旧计划"], status: "completed" },
  ];
  assert.deepEqual(selectRelevantFollowUps(rows, "灯塔计划准备得怎么样", 3).map(({ id }) => id), [1]);
  assert.deepEqual(selectRelevantFollowUps(rows, "今天吃什么", 3), []);
});

test("formatFollowUps adds low-pressure boundaries", () => {
  const text = formatFollowUps([{ title: "申请", kind: "waiting_result", status: "waiting", content: "等待回复", allow_proactive: true }]);
  assert.match(text, /at most once/);
  assert.match(text, /Do not scold/);
  assert.match(text, /follow-up allowed/);

  const contextOnly = formatFollowUps([{ title: "申请", kind: "waiting_result", status: "waiting", content: "等待回复", allow_proactive: false }]);
  assert.match(contextOnly, /do not initiate a follow-up/);
});
test("suggestFollowUpStatus proposes conservative user-confirmed transitions", () => {
  const active = [{ id: "plan-1", title: "灯塔计划", status: "active" }];
  assert.deepEqual(suggestFollowUpStatus(active, "灯塔计划已经完成了"), {
    followUpId: "plan-1",
    title: "灯塔计划",
    currentStatus: "active",
    suggestedStatus: "completed",
    reason: "你似乎在说这件事已经有了结果",
  });
  assert.equal(suggestFollowUpStatus([{ ...active[0], status: "waiting" }], "还在等待回复"), null);
  assert.equal(suggestFollowUpStatus(active, "今天只是随便聊聊"), null);
  assert.equal(suggestFollowUpStatus(active, "希望这次能够成功"), null);
});

test("selectContextualFollowUps resolves a pronoun-like status update from nearby chat", () => {
  const rows = [
    { id: "plan-1", title: "灯塔计划", content: "周日模拟面试", triggers: ["灯塔计划"], status: "active" },
    { id: "plan-2", title: "旅行计划", content: "年底旅行", triggers: ["旅行计划"], status: "active" },
  ];
  assert.deepEqual(
    selectContextualFollowUps(rows, "已经完成了", [{ content: "灯塔计划准备得怎么样？" }]).map(({ id }) => id),
    ["plan-1"],
  );
  assert.deepEqual(
    selectContextualFollowUps(rows, "我还在等结果", [{ content: "灯塔计划和旅行计划都怎么样？" }]),
    [],
  );
  assert.deepEqual(selectContextualFollowUps(rows, "今天吃什么", [{ content: "灯塔计划" }]), []);
});
test("status selection works for arbitrary topic names without creating memories", () => {
  const topics = [
    { id: "a", title: "签证申请", content: "等待使馆结果", triggers: ["签证", "使馆"], status: "completed" },
    { id: "b", title: "秋季旅行", content: "规划路线", triggers: ["旅行"], status: "paused" },
  ];
  assert.deepEqual(selectStatusRelevantFollowUps(topics, "签证申请还在等结果").map(({ id }) => id), ["a"]);
  assert.deepEqual(selectStatusRelevantFollowUps(topics, "签证申请和秋季旅行都有结果"), []);
});
