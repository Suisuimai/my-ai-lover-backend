const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatTiming, persistChatUsage } = require("../core/chatTiming");

test("parallel stages are independent and total is not their sum", async () => {
  let clock = 0;
  const timing = createChatTiming(() => clock);
  const settings = timing.start("settings");
  clock = 2;
  const history = timing.start("recent_history");
  clock = 10;
  settings();
  clock = 12;
  history();
  timing.mark("round_complete");
  const rows = Object.fromEntries(timing.snapshot().map((row) => [row.stage, row]));
  assert.equal(rows.settings.ms, 10);
  assert.equal(rows.recent_history.ms, 10);
  assert.equal(rows.round_complete.ms, 12);
  assert.deepEqual(rows.embedding_request, { stage: "embedding_request", ms: 0, success: false });
});

test("errors and database error results mark failure without changing results", async () => {
  const timing = createChatTiming();
  const failure = new Error("private message");
  await assert.rejects(timing.measure("settings", () => { throw failure; }), failure);
  const result = { error: { message: "private database content" } };
  assert.equal(await timing.measure("bm25_lexical", () => result), result);
  assert.equal(timing.snapshot().find((row) => row.stage === "settings").success, false);
  assert.equal(JSON.stringify(timing.snapshot()).includes("private"), false);
});

test("milestones are first-only and unknown stage data cannot be persisted", () => {
  let clock = 0;
  const timing = createChatTiming(() => clock);
  clock = 3;
  timing.mark("first_sse_data");
  clock = 20;
  timing.mark("first_sse_data");
  assert.equal(timing.snapshot().find((row) => row.stage === "first_sse_data").ms, 3);
  assert.throws(() => timing.mark("secret prompt"));
  assert.ok(timing.snapshot().every((row) => Object.keys(row).join(",") === "stage,ms,success"));
});

test("ledger persistence does not wait and tolerates failure", async () => {
  const timing = createChatTiming();
  const event = { provider_usage: { existing: 1 } };
  let written;
  assert.equal(persistChatUsage(event, timing, (value) => {
    written = value;
    throw new Error("ledger down");
  }), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.provider_usage.existing, 1);
  assert.ok(Array.isArray(written.provider_usage.preparation_breakdown));
  assert.equal(event.provider_usage.preparation_breakdown, undefined);
  persistChatUsage(event, timing, () => new Promise(() => {}));
});
