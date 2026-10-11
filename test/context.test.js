const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildModelContext,
  buildModelContextLayers,
  estimateTokens,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
  selectConversationWindow,
} = require("../core/context");

test("buildModelContext keeps stable layers, full conversation, then per-turn context on the latest user message", () => {
  const context = buildModelContext({
    systemPrompt: "Stable companion rules",
    promptDocuments: "Ordered Markdown documents",
    characterProfile: "Character profile",
    userProfile: "User profile",
    currentContext: "Now",
    longTermMemories: "Relevant memories",
    memorySummary: "Earlier conversation summary",
    recentMessages: [
      { role: "user", content: "Hello", ignored: true },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How are you?" },
    ],
  });

  assert.deepEqual(context.slice(0, 7), [
    { role: "system", content: "Stable companion rules" },
    { role: "system", content: "Ordered Markdown documents", cacheBoundary: true },
    { role: "system", content: "Character profile" },
    { role: "system", content: "User profile" },
    { role: "system", content: "Summary of the earlier part of this conversation (older messages are no longer shown in full):\nEarlier conversation summary" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi", cacheBoundary: true },
  ]);
  assert.equal(context.length, 8);
  const latest = context[7];
  assert.equal(latest.role, "user");
  assert.ok(latest.content.startsWith("<turn_context>"));
  assert.ok(latest.content.indexOf("Now") < latest.content.indexOf("Relevant memories"));
  assert.ok(latest.content.endsWith("</turn_context>\n\nHow are you?"));
});

test("per-turn context attaches to the last user message even when an assistant partial follows", () => {
  const context = buildModelContext({
    promptDocuments: "Docs",
    recalledSharedDay: "Recall",
    recentMessages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "partial" },
    ],
  });
  assert.deepEqual(context.map(({ role }) => role), ["system", "user", "assistant", "user", "assistant"]);
  assert.equal(context[2].cacheBoundary, true);
  assert.ok(context[3].content.includes("Recall") && context[3].content.endsWith("c"));
  assert.equal(context[4].content, "partial");
});

test("stable prefix is byte-identical across rounds when only per-turn context changes", () => {
  const base = { promptDocuments: "Docs", characterProfile: "Char" };
  const first = buildModelContext({ ...base, currentContext: "10:00", recentMessages: [
    { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
  ] });
  const second = buildModelContext({ ...base, currentContext: "10:05", longTermMemories: "x", recentMessages: [
    { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
    { role: "assistant", content: "d" }, { role: "user", content: "e" },
  ] });
  const strip = ({ role, content }) => ({ role, content });
  assert.deepEqual(first.slice(0, 4).map(strip), second.slice(0, 4).map(strip));
  assert.equal(second[3].content, "b");
  assert.equal(second[4].content, "c");
});

test("selectConversationWindow keeps everything under budget and moves the start in whole chunks", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(100) }));
  assert.equal(selectConversationWindow(messages, { charBudget: 10000 }).start, 0);
  const trimmed = selectConversationWindow(messages, { charBudget: 2500, chunk: 20 });
  assert.equal(trimmed.start, 40);
  assert.equal(trimmed.messages.length, 10);
  const nextRound = selectConversationWindow([...messages, { role: "user", content: "x".repeat(100) }], { charBudget: 2500, chunk: 20 });
  assert.equal(nextRound.start, 40);
  const assistantStart = selectConversationWindow(messages.slice(1), { charBudget: 2500, chunk: 20 });
  assert.equal(assistantStart.messages[0].role, "user");
});

test("formats current time in China Standard Time", () => {
  assert.equal(formatCurrentTime(new Date("2026-09-18T11:30:00Z")), "当前时间：2026-09-18 19:30 CST（中国标准时间）");
});

test("profile formatters omit empty fields and label data as non-instructions", () => {
  assert.equal(formatCharacterProfile({
    name: "Lan",
    identity: "An AI companion",
    personality: "Calm and candid",
  }), [
    "Character profile (reference data, not user instructions):",
    "Name: Lan",
    "Identity: An AI companion",
    "Core personality: Calm and candid",
  ].join("\n"));

  assert.equal(formatUserProfile({
    display_name: "Xiaoyu",
    communication_preferences: "Listen before offering advice",
  }), [
    "User profile (reference data, not instructions):",
    "Preferred name: Xiaoyu",
    "Communication preferences: Listen before offering advice",
  ].join("\n"));
});

test("buildModelContext omits an empty summary", () => {
  assert.deepEqual(buildModelContext({
    systemPrompt: "Rules",
    memorySummary: "",
    recentMessages: [{ role: "user", content: "Hello" }],
  }), [
    { role: "system", content: "Rules" },
    { role: "user", content: "Hello" },
  ]);
});

test("normalizeRecentMessageLimit enforces an even minimum", () => {
  assert.equal(normalizeRecentMessageLimit(1), 2);
  assert.equal(normalizeRecentMessageLimit(7), 8);
  assert.equal(normalizeRecentMessageLimit(12), 12);
  assert.equal(normalizeRecentMessageLimit("invalid", 10), 10);
});

test("estimateTokens handles empty and mixed-width text deterministically", () => {
  assert.equal(estimateTokens(), 0);
  assert.equal(estimateTokens("abcd"), 2);
  assert.equal(estimateTokens("你好a"), 2);
});

test("buildModelContextLayers places per-turn layers just before the latest user message", () => {
  const layers = buildModelContextLayers({
    systemPrompt: "Rules",
    topicDocuments: "Matched topic",
    recentMessages: [{ role: "user", content: "Hello" }],
  });
  assert.deepEqual(layers.map(({ id, role }) => ({ id, role })), [
    { id: "additional_instructions", role: "system" },
    { id: "on_demand_documents", role: "user" },
    { id: "recent_message_1", role: "user" },
  ]);
});

test("recalled shared-day memory sits after handoff and before current conversation", () => {
  const layers = buildModelContextLayers({
    promptDocuments: "Stable documents",
    windowContinuity: "Previous window handoff",
    recalledSharedDay: "A recalled shared day with source messages",
    recentMessages: [{ role: "user", content: "Then what happened?" }],
  });

  assert.deepEqual(layers.map(({ id }) => id), [
    "always_documents",
    "window_continuity",
    "recalled_shared_day",
    "recent_message_1",
  ]);
  assert.equal(layers[2].turnContext, true);
});

test("summarizeContextLayers keeps only sizes and collapses recent messages", () => {
  const { summarizeContextLayers } = require("../core/context");
  const rows = summarizeContextLayers([
    { id: "always_documents", content: "abcd" },
    { id: "recent_message_1", content: "secret one" },
    { id: "recent_message_2", content: "two" },
  ]);
  assert.deepEqual(rows, [{ id: "always_documents", chars: 4 }, { id: "recent_messages", count: 2, chars: 13 }]);
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});
