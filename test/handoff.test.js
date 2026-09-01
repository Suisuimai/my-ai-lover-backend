const test = require("node:test");
const assert = require("node:assert/strict");
const { formatWindowContinuity } = require("../core/handoff");

test("formats confirmed handoff and previous-window tail", () => {
  const output = formatWindowContinuity({ status:"confirmed", body_markdown:"上一窗口在聊旅行。", current_state:"还没决定", continuation_guidance:"自然接着问", open_loops:["一周后再聊"] }, [{ role:"user", content:"到时提醒我" }, { role:"assistant", content:"好。" }]);
  assert.match(output, /上一窗口在聊旅行/);
  assert.match(output, /还没决定/);
  assert.match(output, /到时提醒我/);
});
