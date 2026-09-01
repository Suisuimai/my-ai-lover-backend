const test = require("node:test");
const assert = require("node:assert/strict");
const { formatTimelineEntries, normalizeEvidenceTerms, selectRelevantTimeline } = require("../core/timeline");

test("normalizes multilingual evidence terms", () => {
  assert.deepEqual(normalizeEvidenceTerms("周末；周日、autumn trip"), ["周末", "周日", "autumn trip"]);
});

test("selects the strongest timeline match first", () => {
  const entries = [
    { id:"a", title:"秋季旅行", index_summary:"旅行计划", current_state:"一周后再讨论", body_markdown:"尚未决定", evidence_terms:["旅行"] },
    { id:"b", title:"灯塔计划", index_summary:"等待结果", current_state:"已完成", body_markdown:"计划完成", evidence_terms:["灯塔计划"] },
  ];
  assert.equal(selectRelevantTimeline(entries, "灯塔计划现在如何", 1)[0].id, "b");
});

test("formats time, narrative, and current state", () => {
  const output = formatTimelineEntries([{ title:"秋季旅行", occurred_at:"2026-09-01T00:00:00.000Z", body_markdown:"讨论了旅行。", current_state:"一周后再讨论", index_summary:"未决定的秋季旅行" }]);
  assert.match(output, /2026-09-01/);
  assert.match(output, /讨论了旅行/);
  assert.match(output, /一周后再讨论/);
});
