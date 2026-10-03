const test = require("node:test");
const assert = require("node:assert/strict");
const { applyDiaryReview, reviewEventForAction } = require("../core/diaryReview");

const draft = {
  body_markdown: "她九点回家。我们一起吃了饭。",
  validation_issues: [
    { kind: "fact", text: "她九点回家。", reasons: ["时间无法回源"] },
    { kind: "fact", text: "我们一起吃了饭。", reasons: ["引语无法回源"] },
  ],
};

test("single confirmation appends a confirmable version without mutating the source draft", () => {
  const result = applyDiaryReview(draft, { action: "confirm_fact", issueIndex: 0 });
  assert.equal(result.status, "needs_review");
  assert.equal(result.validationIssues.length, 1);
  assert.equal(draft.validation_issues.length, 2);
  assert.equal(reviewEventForAction("confirm_fact"), "fact_confirmed");
});

test("correction replaces an exact claim and can complete a draft", () => {
  const oneIssue = { ...draft, validation_issues: draft.validation_issues.slice(0, 1) };
  const result = applyDiaryReview(oneIssue, { action: "correct_fact", issueIndex: 0, replacementText: "她八点回家。" });
  assert.equal(result.status, "confirmed");
  assert.match(result.bodyMarkdown, /八点回家/);
  assert.doesNotMatch(result.bodyMarkdown, /九点回家/);
});

test("whole-entry retraction returns a draft marker and keeps history append-only", () => {
  const result = applyDiaryReview({ ...draft, validation_issues: [] }, { action: "revoke_entry" });
  assert.equal(result.status, "needs_review");
  assert.equal(result.validationIssues[0].kind, "manual_retraction");
});
