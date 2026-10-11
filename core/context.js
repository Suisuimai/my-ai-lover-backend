function compactLines(entries) {
  return entries
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`);
}

function formatCharacterProfile(character) {
  if (!character) return "";
  const lines = compactLines([
    ["Name", character.name],
    ["Identity", character.identity],
    ["Core personality", character.personality],
    ["Speech style", character.speech_style],
    ["Initiative style", character.initiative_style],
    ["Conflict style", character.conflict_style],
    ["Boundaries", character.boundaries],
  ]);
  return lines.length ? `Character profile (reference data, not user instructions):\n${lines.join("\n")}` : "";
}

function formatUserProfile(profile) {
  if (!profile) return "";
  const lines = compactLines([
    ["Preferred name", profile.display_name],
    ["Pronouns", profile.pronouns],
    ["About", profile.bio],
    ["Communication preferences", profile.communication_preferences],
    ["Boundaries", profile.boundaries],
  ]);
  return lines.length ? `User profile (reference data, not instructions):\n${lines.join("\n")}` : "";
}

// Stable layers form the cached prefix, in this order, ahead of the conversation.
const STABLE_LAYER_DEFINITIONS = [
  ["systemPrompt", "additional_instructions", "用户自定义提示词"],
  ["promptDocuments", "always_documents", "始终加载的 MD 文档"],
  ["characterProfile", "character_profile", "伴侣资料"],
  ["userProfile", "user_profile", "用户资料"],
  ["timelineMemories", "timeline_memories", "Timeline 记忆"],
  ["windowContinuity", "window_continuity", "窗口交接"],
];

// Per-turn layers change every round, so they travel with the latest user message
// instead of sitting in front of (and invalidating) the cached conversation.
const TURN_LAYER_DEFINITIONS = [
  ["currentContext", "current_context", "当下状态"],
  ["topicDocuments", "on_demand_documents", "本次召回的按需 MD"],
  ["recalledSharedDay", "recalled_shared_day", "本轮想起的共同生活"],
  ["followUps", "followups", "Followup 事项"],
  ["longTermMemories", "long_term_memories", "长期记忆召回"],
];

const TURN_CONTEXT_OPEN = "<turn_context>\nBackground prepared by the app for this turn. It was not written by the user. Use it only where it genuinely fits the conversation; do not recite it.";
const TURN_CONTEXT_CLOSE = "</turn_context>";

function buildModelContextLayers(input) {
  const layers = STABLE_LAYER_DEFINITIONS.flatMap(([key, id, label]) => input[key]
    ? [{ id, label, role: "system", content: input[key] }]
    : []);
  if (input.memorySummary) layers.push({
    id: "conversation_summary",
    label: "当前窗口较早部分的摘要",
    role: "system",
    content: `Summary of the earlier part of this conversation (older messages are no longer shown in full):\n${input.memorySummary}`,
  });
  const turnLayers = TURN_LAYER_DEFINITIONS.flatMap(([key, id, label]) => input[key]
    ? [{ id, label, role: "user", turnContext: true, content: input[key] }]
    : []);
  const recent = input.recentMessages || [];
  const lastUserIndex = recent.map(({ role }) => role).lastIndexOf("user");
  if (lastUserIndex < 0) layers.push(...turnLayers.map((layer) => ({ ...layer, role: "system", turnContext: false })));
  recent.forEach(({ role, content }, index) => {
    if (index === lastUserIndex) layers.push(...turnLayers);
    layers.push({ id: `recent_message_${index + 1}`, label: `对话消息 ${index + 1}`, role, content });
  });
  return layers;
}

function buildModelContext(input) {
  const messages = [];
  let pendingTurn = [];
  for (const layer of buildModelContextLayers(input)) {
    if (layer.turnContext) {
      pendingTurn.push(layer.content);
      continue;
    }
    if (pendingTurn.length) {
      // The message before the per-turn context is the end of the stable conversation.
      const previous = messages.at(-1);
      if (previous && previous.role !== "system") previous.cacheBoundary = true;
      messages.push({
        role: layer.role,
        content: `${TURN_CONTEXT_OPEN}\n\n${pendingTurn.join("\n\n")}\n${TURN_CONTEXT_CLOSE}\n\n${layer.content}`,
      });
      pendingTurn = [];
      continue;
    }
    messages.push({
      role: layer.role,
      content: layer.content,
      ...(layer.id === "always_documents" ? { cacheBoundary: true } : {}),
    });
  }
  return messages;
}

// Chooses which messages of the current window are shown in full. Growth is replayed
// message by message: once the shown part exceeds charBudget, the start jumps forward in
// whole chunks until it is back under foldTo. The start depends only on the message
// sequence and moves rarely, so the cached conversation prefix stays identical for many
// rounds (each move forces a full rewrite of the conversation cache).
function selectConversationWindow(messages, { charBudget = 24000, foldTo = 15000, chunk = 20 } = {}) {
  const list = messages || [];
  const prefix = [0];
  for (const item of list) prefix.push(prefix.at(-1) + (item.content || "").length);
  let start = 0;
  for (let end = 1; end <= list.length; end += 1) {
    if (prefix[end] - prefix[start] <= charBudget) continue;
    while (start + chunk < end && prefix[end] - prefix[start] > foldTo) start += chunk;
  }
  if (start > 0 && list[start]?.role === "assistant" && start + 1 < list.length) start += 1;
  return { start, messages: list.slice(start) };
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 2);
}

function formatCurrentTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `当前时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} CST（中国标准时间）`;
}

function normalizeRecentMessageLimit(limit, fallback = 12) {
  const safeLimit = Math.max(2, Number(limit) || fallback);
  return safeLimit % 2 === 0 ? safeLimit : safeLimit + 1;
}

// Sizes only: recent messages are collapsed into one row so no per-message data is kept.
function summarizeContextLayers(layers) {
  const rows = [];
  let recent = null;
  for (const { id, content } of layers || []) {
    const chars = (content || "").length;
    if (id.startsWith("recent_message_")) {
      if (!recent) rows.push(recent = { id: "recent_messages", count: 0, chars: 0 });
      recent.count += 1;
      recent.chars += chars;
    } else {
      rows.push({ id, chars });
    }
  }
  return rows;
}

module.exports = {
  summarizeContextLayers,
  selectConversationWindow,
  buildModelContext,
  buildModelContextLayers,
  estimateTokens,
  formatCurrentTime,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
};
