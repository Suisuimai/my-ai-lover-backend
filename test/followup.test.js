const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatFollowUps,
  parseExplicitFollowUpRequest,
  selectRelevantFollowUps,
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
