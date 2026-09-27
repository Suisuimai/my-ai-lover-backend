function uniqueIntegers(value, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((number) => Number.isInteger(number) && number >= 1 && number <= max))];
}

function uniqueStrings(value, limit = 12, maxLength = 1000) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, limit).map((item) => item.slice(0, maxLength));
}

function extractJsonObject(value) {
  const text = String(value || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Diary model did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function numberedTranscript(messages) {
  return (messages || []).map((message, index) => {
    const time = new Date(message.effective_occurred_at || message.occurred_at).toISOString();
    return `M${index + 1} · ${time} · ${message.role === "user" ? "年妤" : "季疏"}\n${message.raw_content}`;
  }).join("\n\n");
}

function buildGroundedDiaryPrompt({ dayKey, messages }) {
  return [
    "你为季疏整理一天相处结束后的私人日记。只返回 JSON，不要代码块。",
    "日记必须用季疏的第一人称中文书写，语气自然，不写成报告。用户叫年妤，也可以叫妤妤；Companion 指季疏。",
    "原始消息是唯一事实来源。不得补充动机、关系结论、动作或结果。",
    "每项事实必须引用 evidence_message_numbers，并复制至少一段逐字存在于这些消息中的 evidence_quotes。",
    "感受只能写成‘我当时的感受/理解’，不得冒充年妤的客观事实，也必须引用消息编号。",
    "body_markdown 可以有生活气息，但其中涉及事实的内容必须已列入 facts；不确定就不写。",
    `日期：${dayKey}`,
    `JSON 结构：${JSON.stringify({
      title: "",
      body_markdown: "",
      current_state: "",
      facts: [{ text: "", evidence_message_numbers: [1], evidence_quotes: [""] }],
      feelings: [{ text: "", evidence_message_numbers: [1] }],
    })}`,
    "原始消息：",
    numberedTranscript(messages),
  ].join("\n\n");
}

function parseGroundedDiary(raw, sourceMessages) {
  const parsed = extractJsonObject(raw);
  if (!parsed.title || !parsed.body_markdown) throw new Error("Diary model omitted its title or body");
  const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 30) : [];
  const feelings = Array.isArray(parsed.feelings) ? parsed.feelings.slice(0, 20) : [];
  return {
    title: String(parsed.title).trim().slice(0, 160),
    bodyMarkdown: String(parsed.body_markdown).trim().slice(0, 30000),
    currentState: String(parsed.current_state || "").trim().slice(0, 3000),
    facts: facts.map((item) => ({
      text: String(item?.text || "").trim().slice(0, 3000),
      evidenceNumbers: uniqueIntegers(item?.evidence_message_numbers, sourceMessages.length),
      evidenceQuotes: uniqueStrings(item?.evidence_quotes, 8, 2000),
    })).filter((item) => item.text),
    feelings: feelings.map((item) => ({
      text: String(item?.text || "").trim().slice(0, 3000),
      evidenceNumbers: uniqueIntegers(item?.evidence_message_numbers, sourceMessages.length),
    })).filter((item) => item.text),
  };
}

function documentaryTokens(value) {
  const text = String(value || "");
  const numeric = text.match(/\d+(?:[.:：/\-]\d+)*/g) || [];
  const temporal = text.match(/今天|昨天|明天|早上|上午|中午|下午|晚上|凌晨|周[一二三四五六日天]|星期[一二三四五六日天]|第[一二三四五六七八九十百两〇零]+天|[一二三四五六七八九十百两〇零]+(?:点|时|分|月|日|号)/g) || [];
  const quoted = [...text.matchAll(/[“"]([^”"]{1,100})[”"]/g)].map((match) => match[1]);
  return [...new Set([...numeric, ...temporal, ...quoted])];
}

const chineseHours = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三"];

function timestampEvidence(message) {
  const raw = message.effective_occurred_at || message.occurred_at;
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const aliases = [
    `${parts.year}-${parts.month}-${parts.day}`,
    `${Number(parts.month)}月${Number(parts.day)}日`,
    `${Number(parts.month)}月${Number(parts.day)}号`,
    `${hour}:${String(minute).padStart(2, "0")}`,
    `${hour}点`, `${chineseHours[hour]}点`,
  ];
  if (hour === 0) aliases.push("零点", "凌晨");
  else if (hour < 6) aliases.push("凌晨");
  else if (hour < 9) aliases.push("早上");
  else if (hour < 12) aliases.push("上午");
  else if (hour < 14) aliases.push("中午");
  else if (hour < 18) aliases.push("下午");
  else aliases.push("晚上");
  return aliases.join(" ");
}

function evidenceText(messages, dayKey = "") {
  return [
    ...messages.flatMap((message) => [String(message.raw_content || ""), timestampEvidence(message)]),
    dayKey ? `${dayKey} 今天` : "",
  ].filter(Boolean).join("\n");
}

function validateGroundedDiary(diary, sourceMessages, { dayKey = "" } = {}) {
  const issues = [];
  const validFacts = [];
  const validFeelings = [];
  const citedSources = (numbers) => numbers.map((number) => sourceMessages[number - 1]).filter(Boolean);

  diary.facts.forEach((fact, index) => {
    const cited = citedSources(fact.evidenceNumbers);
    const citedText = evidenceText(cited, dayKey);
    const factIssues = [];
    if (!cited.length) factIssues.push("没有有效的原始消息编号");
    if (!fact.evidenceQuotes.length) factIssues.push("没有逐字证据");
    for (const quote of fact.evidenceQuotes) if (!citedText.includes(quote)) factIssues.push(`原文中找不到引语：${quote.slice(0, 80)}`);
    for (const token of documentaryTokens(fact.text)) if (!citedText.includes(token)) factIssues.push(`原文中找不到时间、数字或引语：${token}`);
    if (factIssues.length) {
      issues.push({ kind: "fact", itemIndex: index, text: fact.text, reasons: [...new Set(factIssues)] });
    } else {
      validFacts.push({ ...fact, sourceMessageIds: cited.map((message) => message.id) });
    }
  });

  diary.feelings.forEach((feeling, index) => {
    const cited = citedSources(feeling.evidenceNumbers);
    if (!cited.length) {
      issues.push({ kind: "feeling", itemIndex: index, text: feeling.text, reasons: ["没有有效的原始消息编号"] });
    } else {
      validFeelings.push({ ...feeling, sourceMessageIds: cited.map((message) => message.id) });
    }
  });

  if (!diary.facts.length && !diary.feelings.length) {
    issues.push({ kind: "empty", itemIndex: null, text: "", reasons: ["日记没有可回源的事实或感受"] });
  }

  const wholeSource = evidenceText(sourceMessages, dayKey);
  const missingBodyTokens = documentaryTokens(diary.bodyMarkdown).filter((token) => !wholeSource.includes(token));
  if (missingBodyTokens.length) {
    issues.push({
      kind: "body", itemIndex: null, text: diary.bodyMarkdown,
      reasons: missingBodyTokens.map((token) => `日记正文中的时间、数字或引语无法回源：${token}`),
    });
  }

  return { issues, validFacts, validFeelings };
}

module.exports = {
  buildGroundedDiaryPrompt,
  documentaryTokens,
  numberedTranscript,
  parseGroundedDiary,
  validateGroundedDiary,
};
