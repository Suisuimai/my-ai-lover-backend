const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { startChatTask } = require("../core/chatPreparation");
const { createChatTiming } = require("../core/chatTiming");
const { recallSourceIds, selectSourceExcerpt, formatSharedDayRecall } = require("../core/sourceRecall");
const source = fs.readFileSync(require.resolve("../index.js"), "utf8");
const functionSource = source.slice(source.indexOf("async function recallSharedDay("), source.indexOf('app.get("/diary/shared-days"'));

for (const scenario of [
  { name: "confirmed short day", confirmed: true },
  { name: "unconfirmed short day", confirmed: false },
  { name: "partial long day", confirmed: true, long: true },
  { name: "pointer continuation", confirmed: true, pointer: true },
  { name: "source failure", confirmed: true, failSource: true },
]) {
  test(`parallel assembly preserves ${scenario.name}`, { timeout: 2000 }, async () => {
    const ids = Array.from({ length: scenario.long ? 70 : 2 }, (_, index) => `source-${index}`);
    const anchorIds = [ids[0], ids[1]];
    const expectedIds = recallSourceIds(ids, anchorIds);
    const diary = scenario.confirmed ? { body_markdown: "synthetic confirmed diary" } : null;
    const annotations = [{ event_kind: "factual_note_added", content: "synthetic note" }];
    let annotationReads = 0;
    const pointers = [];
    let releaseDiary;
    const diaryGate = new Promise((resolve) => { releaseDiary = resolve; });
    const rawRows = expectedIds.map((id, index) => ({
      id, role: index % 2 ? "assistant" : "user", raw_content: `original text ${index}`,
      occurred_at: `2026-10-01T10:00:0${index}Z`,
      source_metadata: { original_message_created_at: `2026-10-01T10:00:0${index}Z` },
    }));
    const query = (table) => {
      const chain = {
        select() { return chain; }, eq() { return chain; }, order() { return chain; },
        limit() { return chain; }, in() { return chain; },
        single() { return chain; }, maybeSingle() { return chain; },
        upsert(value) { pointers.push(value); return chain; },
        then(resolve, reject) {
          let data;
          if (table === "shared_life_days") data = { day_key: "2026-10-01" };
          if (table === "shared_life_day_versions") data = { source_message_ids: ids };
          if (table === "diary_review_events") { annotationReads++; data = annotations; }
          if (table === "memory_recall_pointers") data = {
            shared_day_id: "day", anchor_source_message_ids: anchorIds,
          };
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    };
    const context = {
      Date, startChatTask, recallSourceIds, selectSourceExcerpt, formatSharedDayRecall,
      supabase: { from: query },
      querySourceRecallCandidates: async () => ({
        terms: ["synthetic"], ranked: scenario.pointer ? [] : [{
          sharedDayId: "day", anchorSourceMessageIds: anchorIds,
        }],
      }),
      shouldContinueRecallPointer: () => true,
      loadConfirmedDiaryForDay: async () => { await diaryGate; return diary; },
      readSourceMessagesByIds: async (userId, characterId, selectedIds) => {
        assert.equal(userId, "user");
        assert.equal(characterId, "character");
        assert.deepEqual(Array.from(selectedIds), expectedIds);
        releaseDiary();
        if (scenario.failSource) throw new Error("source read failed");
        return rawRows;
      },
    };
    const recall = vm.runInNewContext(`${functionSource}\nrecallSharedDay`, context);
    const timing = createChatTiming();
    const request = {
      userId: "user", characterId: "character", sessionId: "session",
      message: "synthetic", allowSemantic: false, writePointer: true, timing,
    };
    if (scenario.failSource) {
      await assert.rejects(recall(request), /source read failed/);
      assert.equal(pointers.length, 0);
      assert.equal(timing.snapshot().find((row) => row.stage === "diary_source_assembly").success, false);
      return;
    }
    const result = await recall(request);
    const messages = rawRows.map((row) => ({
      id: row.id, role: row.role, content: row.raw_content,
      occurredAt: row.source_metadata.original_message_created_at,
    }));
    assert.equal(result, formatSharedDayRecall({
      dayKey: "2026-10-01", diary,
      annotations: diary ? annotations : [], messages, partial: Boolean(scenario.long),
    }));
    assert.equal(annotationReads, diary ? 1 : 0);
    assert.equal(pointers.length, 1);
    assert.deepEqual(Array.from(pointers[0].anchor_source_message_ids), anchorIds);
  });
}
