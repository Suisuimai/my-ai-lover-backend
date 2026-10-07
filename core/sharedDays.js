const SHANGHAI_OFFSET_HOURS = 8;
const DEFAULT_DAY_CUTOFF_HOUR = 7;

function shanghaiParts(value) {
  const shifted = new Date(new Date(value).getTime() + SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000);
  if (Number.isNaN(shifted.getTime())) throw new Error("Invalid source message time");
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

function shiftedDayKey(value, cutoffHour = DEFAULT_DAY_CUTOFF_HOUR) {
  const shifted = new Date(new Date(value).getTime() + (SHANGHAI_OFFSET_HOURS - cutoffHour) * 60 * 60 * 1000);
  if (Number.isNaN(shifted.getTime())) throw new Error("Invalid source message time");
  return shifted.toISOString().slice(0, 10);
}

function normalizeMarkerText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function hasMorningMarker(value) {
  const text = normalizeMarkerText(value);
  if (!text || /(?:昨天|昨晚|没有|没|不是).{0,8}(?:早安|早上好)/.test(text)) return false;
  return /(?:^|[,，.。?？!！\s])(早安|早上好|我醒了|醒啦|醒了|起床啦|起床了|睡醒啦|睡醒了)(?:$|[,，.。?？!！~\s])/.test(text);
}

function hasNightMarker(value) {
  const text = normalizeMarkerText(value);
  if (!text || /(?:昨天|昨晚|没有|没|不是).{0,8}晚安/.test(text)) return false;
  return /(?:^|[,，.。?？!！\s])(晚安|我睡了|睡觉啦|睡觉了|去睡啦|去睡了|先睡啦|先睡了|准备睡觉|梦里见|明天见)(?:$|[,，.。?？!！~\s])/.test(text);
}

function currentSourceMessages(messages) {
  const latestLive = new Map();
  const imported = [];
  for (const message of messages || []) {
    if (!message?.id || !message.occurred_at) continue;
    if (message.operational_message_id) {
      const previous = latestLive.get(message.operational_message_id);
      if (!previous || Number(message.revision_number || 0) > Number(previous.revision_number || 0)) {
        latestLive.set(message.operational_message_id, message);
      }
    } else {
      imported.push(message);
    }
  }
  return [...latestLive.values(), ...imported]
    .map((message) => ({
      ...message,
      effective_occurred_at: message.source_metadata?.original_message_created_at || message.occurred_at,
    }))
    .sort((left, right) => new Date(left.effective_occurred_at) - new Date(right.effective_occurred_at)
      || String(left.id).localeCompare(String(right.id)));
}

function groupSourceMessagesBySharedDay(messages, { cutoffHour = DEFAULT_DAY_CUTOFF_HOUR } = {}) {
  const groups = new Map();
  for (const message of currentSourceMessages(messages)) {
    const occurredAt = message.effective_occurred_at;
    const local = shanghaiParts(occurredAt);
    const morning = hasMorningMarker(message.raw_content);
    const night = hasNightMarker(message.raw_content);
    const dayKey = morning && local.hour < cutoffHour
      ? local.date
      : shiftedDayKey(occurredAt, cutoffHour);
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push({ ...message, morning, night });
  }

  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  return ordered.map(([dayKey, items], index) => {
    const morning = items.find((item) => item.morning);
    const night = [...items].reverse().find((item) => item.night);
    return {
      dayKey,
      startedAt: items[0].effective_occurred_at,
      endedAt: items.at(-1).effective_occurred_at,
      sourceMessageIds: items.map((item) => item.id),
      firstSourceMessageId: items[0].id,
      lastSourceMessageId: items.at(-1).id,
      morningMarkerSourceId: morning?.id || null,
      nightMarkerSourceId: night?.id || null,
      boundaryState: index < ordered.length - 1 || Boolean(night) ? "sealed" : "open",
      boundaryReason: night ? "night_marker" : index < ordered.length - 1 ? "next_shared_day" : "awaiting_end",
    };
  });
}

function sharedDayVersionView(version) {
  if (!version) return null;
  return {
    id: version.id,
    revision_number: version.revision_number,
    started_at: version.started_at,
    ended_at: version.ended_at,
    morning_marker_source_id: version.morning_marker_source_id,
    night_marker_source_id: version.night_marker_source_id,
    boundary_state: version.boundary_state,
    boundary_reason: version.boundary_reason,
    source_message_count: Array.isArray(version.source_message_ids) ? version.source_message_ids.length : 0,
    created_at: version.created_at,
  };
}

module.exports = {
  DEFAULT_DAY_CUTOFF_HOUR,
  currentSourceMessages,
  groupSourceMessagesBySharedDay,
  hasMorningMarker,
  hasNightMarker,
  sharedDayVersionView,
  shiftedDayKey,
};
