const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { createChatTiming, persistChatUsage } = require("../core/chatTiming");
const source = fs.readFileSync(require.resolve("../index.js"), "utf8");

test("real callModel records first delta and defers chat usage without blocking streaming", async () => {
  const timing = createChatTiming();
  let event;
  let writes = 0;
  let deltas = 0;
  const context = {
    performance, Date,
    getModelTarget: async () => ({
      type: "openai-compatible", name: "openrouter", model: "anthropic/test", apiKey: "test-only",
    }),
    prepareMessagesForProvider: (messages) => messages,
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null } }),
    readModelEventStream: async (_, { onDelta }) => {
      onDelta("a", "a");
      onDelta("b", "ab");
      return { text: "ab", data: {}, completion: { complete: true, status: "complete" } };
    },
    normalizeModelUsage: () => ({ providerUsage: { existing: 1 } }),
    recordModelUsage: () => { writes++; return new Promise(() => {}); },
  };
  const functionSource = source.slice(source.indexOf("async function callModel("), source.indexOf("async function maybeCompressMemory("));
  const callModel = vm.runInNewContext(`${functionSource}\ncallModel`, context);
  const reply = await callModel({
    userId: "user", messages: [], timing, preparationMs: 0,
    onDelta: () => { deltas++; timing.mark("first_sse_data"); },
    onUsage: (value) => { event = value; },
  });
  assert.equal(reply, "ab");
  assert.equal(deltas, 2);
  assert.equal(writes, 0);
  assert.equal(event.status, "succeeded");
  const rows = Object.fromEntries(timing.snapshot().map((row) => [row.stage, row]));
  assert.ok(rows.upstream_first_token.success);
  assert.ok(rows.upstream_request.success);
  assert.ok(rows.first_sse_data.ms >= rows.upstream_first_token.ms);
  assert.equal(event.first_token_ms, Math.trunc(rows.upstream_first_token.ms));
  assert.ok(Number.isInteger(event.duration_ms));
  assert.ok(Number.isInteger(event.first_token_ms));
});

test("real /chat persists breakdown after final SSE, independent of a hung ledger", async () => {
  let route;
  let persisted;
  let ended = false;
  const events = [];
  const query = (table) => {
    let action = "select";
    const chain = {
      select() { return chain; }, eq() { return chain; }, order() { return chain; },
      limit() { return chain; }, insert() { action = "insert"; return chain; },
      update() { action = "update"; return chain; },
      single() { return chain; }, maybeSingle() { return chain; },
      then(resolve, reject) {
        const data = table === "chat_requests"
          ? (action === "select" ? null : { id: "request", session_id: "session" })
          : table === "messages" ? (action === "insert" ? { id: "message" } : [])
            : null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };
  const context = {
    app: { post: (_, handler) => { route = handler; } },
    performance, Date, AbortController, console, createChatTiming, persistChatUsage,
    validUuid: () => true, supabase: { from: query }, activeChatControllers: new Map(),
    requireOwnedSession: async () => ({ character_id: "character" }),
    getSettings: async () => ({ model: "test" }),
    getOwnedCharacter: async () => ({ id: "character" }),
    getOrCreateUserProfile: async () => ({}),
    maybeCompressMemory: async () => "",
    normalizeRecentMessageLimit: () => 12,
    loadPromptDocuments: async () => [],
    loadWindowContinuity: async () => ({}),
    recallMemories: async () => [], loadStatusFollowUps: async () => [],
    recallSharedDay: async ({ allowSemantic }) => {
      assert.equal(allowSemantic, false);
      return "";
    },
    selectRelevantPromptDocuments: () => [], selectRelevantFollowUps: () => [],
    selectContextualFollowUps: () => [], buildModelContext: () => [],
    formatPromptDocuments: () => "", formatCurrentTime: () => "",
    formatRetrievedPromptDocuments: () => "", formatCharacterProfile: () => "",
    formatUserProfile: () => "", formatWindowContinuity: () => "",
    formatFollowUps: () => "", formatLongTermMemories: () => "",
    callModel: async ({ timing, onDelta, onCompletion, onUsage }) => {
      timing.mark("upstream_first_token");
      onDelta("reply", "reply");
      onCompletion({ complete: true, status: "complete", finishReason: "stop" });
      onUsage({ provider_usage: { existing: 1 } });
      return "reply";
    },
    touchSession: async () => {}, suggestFollowUpStatus: () => null,
    parseExplicitMemoryRequest: () => null, parseExplicitFollowUpRequest: () => null,
    hasMorningMarker: () => false, hasNightMarker: () => false,
    recordModelUsage: (value) => {
      assert.equal(ended, true);
      persisted = value;
      return new Promise(() => {});
    },
  };
  const start = source.indexOf('app.post("/chat",');
  const end = source.indexOf("\napp.listen(", start);
  assert.ok(end > start);
  vm.runInNewContext(source.slice(start, end), context);
  const timing = createChatTiming();
  timing.mark("authentication");
  const req = {
    body: { message: "test", clientRequestId: "request", sessionId: "session" },
    headers: { accept: "text/event-stream" }, user: { id: "user" }, chatTiming: timing,
  };
  const res = {
    setHeader() {}, flushHeaders() {},
    write(value) { events.push(value.split("\n")[0]); },
    end() { ended = true; },
  };
  await route(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["event: delta", "event: done"]);
  assert.ok(persisted);
  const rows = Object.fromEntries(persisted.provider_usage.preparation_breakdown.map((row) => [row.stage, row]));
  for (const stage of ["authentication", "session_load", "settings", "character", "user_profile", "recent_history", "prompt_assembly", "first_sse_data", "round_complete"]) {
    assert.equal(rows[stage].success, true, stage);
  }
  assert.equal(rows.embedding_request.success, false);
  assert.equal(rows.embedding_request.ms, 0);
});

test("real callModel retains a failed usage event without leaking the thrown error", async () => {
  const timing = createChatTiming();
  let event;
  const context = {
    performance, Date,
    getModelTarget: async () => ({
      type: "openai-compatible", name: "openrouter", model: "test", apiKey: "test-only",
    }),
    prepareMessagesForProvider: (messages) => messages,
    fetch: async () => { throw new Error("sensitive transport error"); },
    normalizeModelUsage: () => ({ providerUsage: {} }),
  };
  const functionSource = source.slice(source.indexOf("async function callModel("), source.indexOf("async function maybeCompressMemory("));
  const callModel = vm.runInNewContext(`${functionSource}\ncallModel`, context);
  await assert.rejects(callModel({
    userId: "user", messages: [], timing, onUsage: (value) => { event = value; },
  }), /sensitive transport error/);
  assert.equal(event.status, "failed");
  assert.equal(timing.snapshot().find((row) => row.stage === "upstream_request").success, false);
  assert.equal(JSON.stringify(timing.snapshot()).includes("sensitive"), false);
  assert.ok(Number.isInteger(event.duration_ms));
  assert.equal(event.first_token_ms, null);
});

test("real model usage is compatible with integer SQL columns under fractional clocks", async () => {
  let clock = 100.125;
  const timing = createChatTiming(() => clock);
  clock += 12.75;
  let event;
  const context = {
    performance: { now: () => clock }, Date,
    getModelTarget: async () => ({
      type: "openai-compatible", name: "openrouter", model: "test", apiKey: "test-only",
    }),
    prepareMessagesForProvider: (messages) => messages,
    fetch: async () => {
      clock += 1.25;
      return { ok: true, status: 200, headers: { get: () => null } };
    },
    readModelEventStream: async (_, { onDelta }) => {
      clock += 2.375;
      onDelta("reply", "reply");
      clock += 3.125;
      return { text: "reply", data: {}, completion: { complete: true, status: "complete" } };
    },
    normalizeModelUsage: () => ({ providerUsage: {} }),
  };
  const functionSource = source.slice(source.indexOf("async function callModel("), source.indexOf("async function maybeCompressMemory("));
  const callModel = vm.runInNewContext(`${functionSource}\ncallModel`, context);
  await callModel({
    userId: "user", messages: [], timing, preparationMs: 12.75,
    onDelta: () => {}, onUsage: (value) => { event = value; },
  });
  // Emulate the integer-column constraint at the real usage-write boundary.
  for (const column of ["duration_ms", "preparation_ms", "first_token_ms"]) {
    assert.ok(Number.isInteger(event[column]), column);
    assert.ok(event[column] >= 0, column);
  }
  assert.equal(event.duration_ms, 6);
  assert.equal(event.first_token_ms, 16);
  assert.equal(event.preparation_ms, 12);
  assert.equal(timing.snapshot().find((row) => row.stage === "upstream_first_token").ms, 16.375);
});
