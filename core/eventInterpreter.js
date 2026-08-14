const EVENT_ACTIONS = new Set(["create", "update"]);
const EVENT_STATUSES = new Set(["active", "waiting", "completed", "paused"]);

function stripJsonFence(value) {
  return String(value || "").trim().replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/i, "");
}

function parseSemanticEventDecision(raw, allowedFollowUps) {
  let value;
  try { value = JSON.parse(stripJsonFence(raw)); } catch { return null; }
  if (!value || !EVENT_ACTIONS.has(value.action) || !EVENT_STATUSES.has(value.suggestedStatus)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.72 || confidence > 1) return null;

  const title = typeof value.title === "string" ? value.title.trim().slice(0, 120) : "";
  const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 240) : "";
  const content = typeof value.content === "string" ? value.content.trim().slice(0, 1200) : "";
  const triggers = Array.isArray(value.triggers)
    ? [...new Set(value.triggers.map((item) => String(item || "").trim()).filter((item) => item.length >= 2))].slice(0, 6)
    : [];
  const due = value.dueAt ? new Date(value.dueAt) : null;
  if (!reason || (due && Number.isNaN(due.getTime()))) return null;

  if (value.action === "update") {
    const target = allowedFollowUps.find((item) => item.id === value.followUpId);
    if (!target) return null;
    return {
      action: "update",
      followUpId: target.id,
      title: target.title,
      currentStatus: target.status,
      suggestedStatus: value.suggestedStatus,
      dueAt: due ? due.toISOString() : null,
      reason,
      confidence,
    };
  }

  if (title.length < 2 || content.length < 2 || !triggers.length) return null;
  const normalizedTitle = title.toLocaleLowerCase();
  if (allowedFollowUps.some((item) => String(item.title || "").trim().toLocaleLowerCase() === normalizedTitle)) {
    return null;
  }
  return {
    action: "create",
    title,
    content,
    triggers,
    kind: ["plan", "promise", "waiting_result", "paused_topic"].includes(value.kind) ? value.kind : "paused_topic",
    suggestedStatus: value.suggestedStatus,
    dueAt: due ? due.toISOString() : null,
    reason,
    confidence,
  };
}

function buildSemanticEventPrompt({ currentMessage, recentMessages, followUps, localDate }) {
  const topics = followUps.map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    content: item.content,
    triggers: item.triggers,
    dueAt: item.due_at,
  }));
  const history = (recentMessages || []).slice(0, 8).reverse().map((item) => ({
    role: item.role,
    content: item.content,
  }));
  return [
    "Interpret whether the user's latest message changes or creates a future-continuity topic for an AI companion.",
    "Understand meaning from the recent conversation, including indirect expressions, negation, and relative dates.",
    "Examples: '不确定，一个星期之后再讨论' may mean create or update a paused topic with a due date one week later; '我不等了' is not waiting.",
    "Return action create/update only when the user meaning is clear. Otherwise return {\"action\":\"none\"}.",
    "Never modify data. This output only proposes a user-confirmed card.",
    "For update, followUpId must be one of the provided IDs. If multiple topics fit, return none.",
    "For create, provide title, content, 1-6 specific triggers, and kind.",
    "Statuses: active, waiting, completed, paused. Kinds: plan, promise, waiting_result, paused_topic.",
    "Return one JSON object only with action, followUpId, title, content, triggers, kind, suggestedStatus, dueAt, reason, confidence.",
    "dueAt must be ISO 8601 or null. reason must be concise Chinese. confidence is 0 to 1.",
    "Current local date and timezone: " + localDate,
    "Existing topics: " + JSON.stringify(topics),
    "Recent conversation: " + JSON.stringify(history),
    "Latest user message: " + currentMessage,
  ].join("\n\n");
}

module.exports = { buildSemanticEventPrompt, parseSemanticEventDecision };
