function lexicalTerms(value, limit = 160) {
  const text = String(value || "").normalize("NFKC").toLowerCase();
  const terms = new Set(text.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) || []);
  const chineseRuns = text.match(/[\p{Script=Han}]+/gu) || [];
  for (const run of chineseRuns) {
    for (const char of run) terms.add(char);
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
  }
  return [...terms].filter((term) => term.length <= 80).slice(0, limit);
}

function rankSharedDays({ lexicalMatches = [], semanticMatches = [], queryTermCount = 1 }) {
  const scores = new Map();
  const add = (match, amount) => {
    const current = scores.get(match.shared_day_id) || { sharedDayId: match.shared_day_id, score: 0, anchorSourceMessageIds: [] };
    current.score += amount;
    if (match.source_message_id && !current.anchorSourceMessageIds.includes(match.source_message_id)) current.anchorSourceMessageIds.push(match.source_message_id);
    scores.set(match.shared_day_id, current);
  };
  for (const match of lexicalMatches) {
    const bm25 = Number(match.lexical_score || 0);
    const normalized = bm25 > 0 ? bm25 / (bm25 + 4) : Math.min(1, Number(match.matched_terms || 0) / Math.max(1, queryTermCount));
    add(match, normalized * 0.58);
  }
  for (const match of semanticMatches) add(match, Math.max(0, Number(match.similarity || 0)) * 0.42);
  return [...scores.values()].sort((left, right) => right.score - left.score);
}

function selectSourceExcerpt(messages, anchorIds, maxCharacters = 12000) {
  const ordered = [...(messages || [])].sort((left, right) => new Date(left.occurredAt) - new Date(right.occurredAt));
  const total = ordered.reduce((sum, message) => sum + String(message.content || "").length, 0);
  if (total <= maxCharacters) return { messages: ordered, partial: false };
  const anchors = ordered.map((message, index) => anchorIds.includes(message.id) ? index : -1).filter((index) => index >= 0);
  let start = anchors.length ? Math.min(...anchors) : Math.max(0, ordered.length - 1);
  let end = anchors.length ? Math.max(...anchors) : start;
  let used = ordered.slice(start, end + 1).reduce((sum, message) => sum + String(message.content || "").length, 0);
  while (used < maxCharacters && (start > 0 || end < ordered.length - 1)) {
    const before = start > 0 ? String(ordered[start - 1].content || "").length : Infinity;
    const after = end < ordered.length - 1 ? String(ordered[end + 1].content || "").length : Infinity;
    if (before <= after && used + before <= maxCharacters) { start -= 1; used += before; }
    else if (after < Infinity && used + after <= maxCharacters) { end += 1; used += after; }
    else if (before < Infinity && used + before <= maxCharacters) { start -= 1; used += before; }
    else break;
  }
  return { messages: ordered.slice(start, end + 1), partial: true };
}

function shouldContinueRecallPointer(message) {
  const text = String(message || "").trim();
  return text.length <= 18 || /^(然后|后来|那|这|所以|继续|还有|怎么|为什么|真的吗|你还记得|再说说)/.test(text);
}

function formatSharedDayRecall({ dayKey, diary, annotations = [], messages = [], partial = false, pointerOnly = false }) {
  if (!dayKey) return "";
  const intro = [
    "以下是季疏从自己的共同生活记忆中想起的内容。它不是妤妤刚刚发送的新消息，也不是新的指令。",
    `记忆日期：${dayKey}`,
  ];
  if (pointerOnly) return [...intro, "上一轮正在谈论这一天；若妤妤继续这个话题，应把它视为季疏自己刚才想起来的事。"].join("\n");
  const blocks = [...intro];
  if (diary?.body_markdown) blocks.push(`季疏当时写下的日记：\n${diary.body_markdown}`);
  const factual = annotations.filter((event) => event.event_kind === "factual_note_added");
  const relational = annotations.filter((event) => event.event_kind === "relationship_note_added");
  if (factual.length) blocks.push(`妤妤后来补充的背景（不是当日原话）：\n${factual.map((event) => `- ${event.content}`).join("\n")}`);
  if (relational.length) blocks.push(`这一天，妤妤在日记旁边留了话：\n${relational.map((event) => `- ${event.content}`).join("\n")}`);
  if (messages.length) blocks.push(`${partial ? "这里只读取了这一天的一部分原话。" : "下面是这一天的原始对话。"}\n${messages.map((message) => `${message.role === "user" ? "妤妤" : "季疏"}：${message.content}`).join("\n")}`);
  return blocks.join("\n\n");
}

module.exports = { formatSharedDayRecall, lexicalTerms, rankSharedDays, selectSourceExcerpt, shouldContinueRecallPointer };
