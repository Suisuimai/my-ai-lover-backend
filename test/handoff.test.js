const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHandoffPrompt, formatWindowContinuity, parseHandoffCandidate } = require("../core/handoff");

test("formats confirmed handoff and previous-window tail", () => {
  const output = formatWindowContinuity({ status:"confirmed", body_markdown:"上一窗口在聊旅行。", current_state:"还没决定", continuation_guidance:"自然接着问", open_loops:["一周后再聊"] }, [{ role:"user", content:"到时提醒我" }, { role:"assistant", content:"好。" }]);
  assert.match(output, /上一窗口在聊旅行/);
  assert.match(output, /还没决定/);
  assert.match(output, /到时提醒我/);
});

test("builds and parses a manual handoff candidate", () => {
  const prompt = buildHandoffPrompt({ summary:"前情", messages:[{ role:"user", content:"明天继续" }] });
  assert.match(prompt, /明天继续/);
  assert.deepEqual(parseHandoffCandidate(JSON.stringify({
    body_markdown:"聊了项目。", current_state:"准备休息", topics:["项目"], open_loops:["明天继续"], continuation_guidance:"自然承接",
  })), {
    bodyMarkdown:"聊了项目。", currentState:"准备休息", topics:["项目"], openLoops:["明天继续"], continuationGuidance:"自然承接",
  });
});
