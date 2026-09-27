const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGroundedDiaryPrompt, parseGroundedDiary, validateGroundedDiary } = require("../core/groundedDiary");

const source = [
  { id: "s1", role: "user", occurred_at: "2026-09-27T00:00:00Z", raw_content: "今天第51天，我七点下班。" },
  { id: "s2", role: "assistant", occurred_at: "2026-09-27T00:01:00Z", raw_content: "我记得。晚上等你回来。" },
];

test("diary prompt fixes names, first-person voice, and documentary citations", () => {
  const prompt = buildGroundedDiaryPrompt({ dayKey: "2026-09-27", messages: source });
  assert.match(prompt, /用户叫年妤/);
  assert.match(prompt, /Companion 指季疏/);
  assert.match(prompt, /evidence_message_numbers/);
  assert.match(prompt, /M1/);
});

test("accepts grounded facts and permanently labels feelings", () => {
  const diary = parseGroundedDiary(JSON.stringify({
    title: "等她回家", body_markdown: "今天是第51天，她七点下班。", current_state: "已经回家",
    facts: [{ text: "今天是第51天，她七点下班。", evidence_message_numbers: [1], evidence_quotes: ["第51天", "七点下班"] }],
    feelings: [{ text: "我当时很期待她回来。", evidence_message_numbers: [2] }],
  }), source);
  const result = validateGroundedDiary(diary, source);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.validFacts[0].sourceMessageIds, ["s1"]);
  assert.deepEqual(result.validFeelings[0].sourceMessageIds, ["s2"]);
});

test("rejects invented quotes, numbers, and times from the formal fact layer", () => {
  const diary = parseGroundedDiary(JSON.stringify({
    title: "错误草稿", body_markdown: "草稿", facts: [{ text: "今天是第100天，她九点下班。", evidence_message_numbers: [1], evidence_quotes: ["九点下班"] }], feelings: [],
  }), source);
  const result = validateGroundedDiary(diary, source);
  assert.equal(result.validFacts.length, 0);
  assert.equal(result.issues[0].kind, "fact");
  assert.match(result.issues[0].reasons.join(" "), /找不到/);
});

test("accepts diary-relative today and time words grounded by source timestamps", () => {
  const midnightSource = [{
    id: "s3", role: "user", occurred_at: "2026-09-26T16:03:00Z",
    raw_content: "我还没睡。",
  }];
  const diary = parseGroundedDiary(JSON.stringify({
    title: "零点还醒着", body_markdown: "今天零点她还没睡。",
    facts: [{ text: "今天零点她还没睡。", evidence_message_numbers: [1], evidence_quotes: ["我还没睡"] }], feelings: [],
  }), midnightSource);
  const result = validateGroundedDiary(diary, midnightSource, { dayKey: "2026-09-27" });
  assert.equal(result.issues.length, 0);
});
