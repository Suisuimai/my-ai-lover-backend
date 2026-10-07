const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currentSourceMessages,
  groupSourceMessagesBySharedDay,
  hasMorningMarker,
  hasNightMarker,
  sharedDayVersionView,
} = require("../core/sharedDays");

function source(id, localIso, rawContent, extra = {}) {
  return { id, occurred_at: localIso, raw_content: rawContent, revision_number: 0, ...extra };
}

test("groups midnight conversation into the preceding shared day", () => {
  const groups = groupSourceMessagesBySharedDay([
    source("a", "2026-09-27T00:10:00+08:00", "还没睡"),
    source("b", "2026-09-27T01:20:00+08:00", "晚安，季疏。"),
    source("c", "2026-09-27T08:00:00+08:00", "早安，醒了。"),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].dayKey, "2026-09-26");
  assert.equal(groups[0].boundaryReason, "night_marker");
  assert.deepEqual(groups[0].sourceMessageIds, ["a", "b"]);
  assert.equal(groups[1].dayKey, "2026-09-27");
});

test("an early morning greeting starts the new calendar day", () => {
  const [group] = groupSourceMessagesBySharedDay([
    source("a", "2026-09-27T06:35:00+08:00", "早安，季疏。"),
  ]);
  assert.equal(group.dayKey, "2026-09-27");
  assert.equal(group.morningMarkerSourceId, "a");
});

test("does not mistake recollections for day boundaries", () => {
  assert.equal(hasMorningMarker("昨天没有说早安。"), false);
  assert.equal(hasNightMarker("昨晚没来得及说晚安。"), false);
  assert.equal(hasMorningMarker("早安，醒了。"), true);
  assert.equal(hasNightMarker("好啦，晚安。"), true);
});

test("uses only the latest correction for a live message", () => {
  const current = currentSourceMessages([
    source("original", "2026-09-27T08:00:00+08:00", "早", { operational_message_id: "m1" }),
    source("correction", "2026-09-27T08:01:00+08:00", "早安", { operational_message_id: "m1", revision_number: 1 }),
  ]);
  assert.deepEqual(current.map((item) => item.id), ["correction"]);
});

test("keeps a correction on the original message day", () => {
  const [group] = groupSourceMessagesBySharedDay([
    source("original", "2026-09-27T08:00:00+08:00", "早", { operational_message_id: "m1" }),
    source("correction", "2026-09-29T12:00:00+08:00", "早安", {
      operational_message_id: "m1", revision_number: 1,
      source_metadata: { original_message_created_at: "2026-09-27T08:00:00+08:00" },
    }),
  ]);
  assert.equal(group.dayKey, "2026-09-27");
});

test("shared-day list views expose counts without returning every source id", () => {
  const view = sharedDayVersionView({
    id: "v1", revision_number: 0, started_at: "start", ended_at: "end",
    source_message_ids: ["s1", "s2", "s3"], boundary_state: "sealed",
    boundary_reason: "night_marker", created_at: "created",
  });
  assert.equal(view.source_message_count, 3);
  assert.equal(view.boundary_state, "sealed");
  assert.equal("source_message_ids" in view, false);
});
