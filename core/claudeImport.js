const MAX_SEGMENT_CHARS = 12000;

function parseClaudeTime(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, month, day, year, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanClaudeSay(role, say) {
  const text = String(say || "").trim();
  if (role !== "assistant") return text;
  return text.replace(/^[\s\S]*?\n\s*Done\s*\n+/i, "").trim();
}

function normalizeClaudeExport(payload) {
  if (!payload || !Array.isArray(payload.messages)) throw new Error("This is not a supported Claude export");
  return payload.messages.map((message, index) => {
    const role = message.role === "human" ? "user" : message.role === "assistant" ? "assistant" : null;
    const occurredAt = parseClaudeTime(message.time);
    const raw = String(message.say || "").trim();
    if (!role || !occurredAt || !raw) throw new Error(`Invalid Claude message at position ${index + 1}`);
    return { role, occurredAt, raw, cleaned: cleanClaudeSay(message.role, raw) };
  });
}

function segmentClaudeMessages(messages, gapMinutes = 30, maxChars = MAX_SEGMENT_CHARS) {
  const segments = [];
  let current = [];
  let size = 0;
  function flush() { if (current.length) segments.push(current); current = []; size = 0; }
  for (const message of messages) {
    const lineSize = message.cleaned.length + 20;
    const previous = current.at(-1);
    const gap = previous ? (message.occurredAt - previous.occurredAt) / 60000 : 0;
    if (current.length && (gap >= gapMinutes || size + lineSize > maxChars)) flush();
    current.push(message); size += lineSize;
  }
  flush();
  return segments.map((items, index) => ({
    sequence: index + 1,
    startedAt: items[0].occurredAt.toISOString(),
    endedAt: items.at(-1).occurredAt.toISOString(),
    messageCount: items.length,
    charCount: items.reduce((total, item) => total + item.cleaned.length, 0),
    rawMessages: items.map(({ role, occurredAt, raw }) => ({ role, time: occurredAt.toISOString(), content: raw })),
    transcript: items.map((item) => `${item.role === "user" ? "User" : "Companion"}: ${item.cleaned}`).join("\n\n"),
  }));
}

function documentaryCharacters(value) {
  return [...String(value || "").normalize("NFKC").toLocaleLowerCase()]
    .filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");
}

function resolveEvidenceQuote(transcript, quote) {
  const source = String(transcript || "");
  const requested = String(quote || "").trim();
  if (!requested) return null;
  const exactIndex = source.indexOf(requested);
  if (exactIndex >= 0) return source.slice(exactIndex, exactIndex + requested.length);

  const target = documentaryCharacters(requested);
  if (target.length < 3) return null;
  let normalized = "";
  const starts = [];
  const ends = [];
  let offset = 0;
  for (const originalCharacter of source) {
    const folded = [...originalCharacter.normalize("NFKC").toLocaleLowerCase()]
      .filter((character) => /[\p{L}\p{N}]/u.test(character));
    for (const character of folded) {
      normalized += character;
      starts.push(offset);
      ends.push(offset + originalCharacter.length);
    }
    offset += originalCharacter.length;
  }
  const normalizedIndex = normalized.indexOf(target);
  if (normalizedIndex < 0) return null;
  return source.slice(starts[normalizedIndex], ends[normalizedIndex + target.length - 1]).trim();
}

function parseTimelineCandidates(raw, transcript, sourceMessages = []) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Memory model did not return JSON");
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.candidates)) throw new Error("Memory model response has no candidates array");
  return parsed.candidates.slice(0, 4).map((item) => {
    const evidenceNumbers = Array.isArray(item.evidence_message_numbers)
      ? [...new Set(item.evidence_message_numbers.filter(Number.isInteger))].slice(0, 6) : [];
    let evidenceQuotes;
    if (sourceMessages.length) {
      if (!evidenceNumbers.length || evidenceNumbers.some((number) => number < 1 || number > sourceMessages.length)) {
        throw new Error("Memory model cited invalid source message numbers");
      }
      evidenceQuotes = evidenceNumbers.map((number) => String(sourceMessages[number - 1].content || "").trim().slice(0, 2000)).filter(Boolean);
    } else {
      const requestedQuotes = Array.isArray(item.evidence_quotes) ? item.evidence_quotes.slice(0, 6) : [];
      evidenceQuotes = requestedQuotes.map((quote) => resolveEvidenceQuote(transcript, quote)).filter(Boolean);
      if (requestedQuotes.length && evidenceQuotes.length !== requestedQuotes.length) {
        throw new Error("Memory model cited words that do not exist in the source segment");
      }
    }
    if (!item.title || !item.body_markdown || !item.current_state || !item.index_summary || !evidenceQuotes.length) {
      throw new Error("A candidate is missing required documentary fields");
    }
    return {
      title: String(item.title).slice(0, 160), bodyMarkdown: String(item.body_markdown).slice(0, 20000),
      currentState: String(item.current_state).slice(0, 3000), indexSummary: String(item.index_summary).slice(0, 1200),
      evidenceQuotes, evidenceTerms: Array.isArray(item.evidence_terms) ? item.evidence_terms.map(String).slice(0, 12) : [],
    };
  });
}

module.exports = { cleanClaudeSay, normalizeClaudeExport, parseClaudeTime, parseTimelineCandidates, segmentClaudeMessages };
