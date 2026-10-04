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

function retrievalQueryTerms(value, limit = 80) {
  return lexicalTerms(value, limit * 2)
    .filter((term) => /^[a-z0-9]/.test(term) ? term.length >= 2 : term.length >= 2)
    .slice(0, limit);
}

function buildRetrievalWindows(corpus, { size = 6, stride = 3 } = {}) {
  const byDay = new Map();
  for (const item of corpus || []) {
    if (!byDay.has(item.sharedDayId)) byDay.set(item.sharedDayId, []);
    byDay.get(item.sharedDayId).push(item.message);
  }
  const windows = [];
  for (const [sharedDayId, messages] of byDay) {
    const ordered = [...messages].sort((left, right) => new Date(left.source_metadata?.original_message_created_at || left.occurred_at)
      - new Date(right.source_metadata?.original_message_created_at || right.occurred_at));
    for (let start = 0; start < ordered.length; start += stride) {
      const slice = ordered.slice(start, start + size);
      if (!slice.length) break;
      const rawText = slice.map((message) => String(message.raw_content || "")).join("\n");
      windows.push({
        sharedDayId,
        sourceMessageIds: slice.map((message) => message.id),
        rawText,
        lexicalTerms: lexicalTerms(rawText),
        occurredAt: slice[0].source_metadata?.original_message_created_at || slice[0].occurred_at,
      });
      if (start + size >= ordered.length) break;
    }
  }
  return windows;
}

function lexicalCandidateAccepted(match) {
  return Number(match?.matched_terms||0)>0&&Number(match?.lexical_score||0)>0;
}

function rankSharedDays({ lexicalMatches = [], semanticMatches = [], rrfK = 60 }) {
  const scores = new Map();
  const add = (match,amount,{anchor=false}={}) => {
    const current = scores.get(match.shared_day_id) || { sharedDayId: match.shared_day_id, score: 0, anchorSourceMessageIds: [] };
    current.score += amount;
    if(anchor){const sourceIds=match.source_message_ids||(match.source_message_id?[match.source_message_id]:[]);for(const sourceId of sourceIds)if(!current.anchorSourceMessageIds.includes(sourceId))current.anchorSourceMessageIds.push(sourceId);}
    scores.set(match.shared_day_id, current);
  };
  const bestRankByDay=(items)=>{const ranks=new Map();items.forEach((item,index)=>{if(!ranks.has(item.shared_day_id))ranks.set(item.shared_day_id,index+1);});return ranks;};
  const lexicalRanks=bestRankByDay(lexicalMatches); const lexicalDays=new Set(lexicalRanks.keys());
  const admittedSemantic=semanticMatches.filter((item)=>lexicalDays.has(item.shared_day_id)); const semanticRanks=bestRankByDay(admittedSemantic);
  lexicalMatches.forEach((match,index)=>{if(lexicalRanks.get(match.shared_day_id)!==index+1)return;add(match,1/(rrfK+index+1),{anchor:true});});
  admittedSemantic.forEach((match,index)=>{if(semanticRanks.get(match.shared_day_id)!==index+1)return;add(match,1/(rrfK+index+1));});
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
  if (messages.length) {
    blocks.push(`下面是这一天的原始对话：\n${messages.map((message) => `${message.role === "user" ? "妤妤" : "季疏"}：${message.content}`).join("\n")}`);
    blocks.push(partial ? "读取范围：这里只读取了这一天的一部分。" : "读取范围：已经读取这一天的完整原话。");
  }
  return blocks.join("\n\n");
}

module.exports = { buildRetrievalWindows, formatSharedDayRecall, lexicalCandidateAccepted, lexicalTerms, rankSharedDays, retrievalQueryTerms, selectSourceExcerpt, shouldContinueRecallPointer };
