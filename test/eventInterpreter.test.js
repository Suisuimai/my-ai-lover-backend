const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSemanticEventPrompt, parseSemanticEventDecision } = require("../core/eventInterpreter");

test("semantic interpreter accepts safe update and create decisions", () => {
  const topics = [{ id: "visa", title: "签证申请", status: "completed" }];
  const update = parseSemanticEventDecision(JSON.stringify({
    action: "update", followUpId: "visa", suggestedStatus: "waiting",
    dueAt: null, reason: "用户仍在等待签证结果", confidence: 0.93,
  }), topics);
  assert.equal(update.title, "签证申请");
  assert.equal(update.suggestedStatus, "waiting");

  const create = parseSemanticEventDecision(JSON.stringify({
    action: "create", title: "秋季旅行", content: "一周后继续讨论秋季旅行",
    triggers: ["秋季旅行", "旅行"], kind: "paused_topic", suggestedStatus: "paused",
    dueAt: "2026-08-21T00:00:00+08:00", reason: "用户想一周后再讨论", confidence: 0.9,
  }), topics);
  assert.equal(create.action, "create");
  assert.equal(create.dueAt, "2026-08-20T16:00:00.000Z");
});

test("semantic interpreter rejects ambiguity, unknown IDs, and low confidence", () => {
  const topics = [{ id: "visa", title: "签证申请", status: "active" }];
  assert.equal(parseSemanticEventDecision('{"action":"none"}', topics), null);
  assert.equal(parseSemanticEventDecision('{"action":"create","title":"签证申请","content":"重复","triggers":["签证"],"suggestedStatus":"paused","reason":"重复","confidence":0.9}', topics), null);
  assert.equal(parseSemanticEventDecision('{"action":"update","followUpId":"other","suggestedStatus":"paused","reason":"x","confidence":0.9}', topics), null);
  assert.equal(parseSemanticEventDecision('{"action":"create","title":"旅行","content":"以后再说","triggers":["旅行"],"suggestedStatus":"paused","reason":"不明确","confidence":0.4}', topics), null);
});

test("semantic prompt includes arbitrary topics and recent context", () => {
  const prompt = buildSemanticEventPrompt({
    currentMessage: "不确定，一个星期之后再讨论",
    recentMessages: [{ role: "user", content: "秋季旅行去哪里？" }],
    followUps: [],
    localDate: "2026-08-14 Asia/Shanghai",
  });
  assert.match(prompt, /秋季旅行/);
  assert.match(prompt, /一个星期之后再讨论/);
});
