function formatWindowContinuity(handoff, tailMessages = []) {
  if (!handoff) return "";
  const parts = [
    "Previous window continuity (background context; do not force these topics):",
    handoff.status === "auto" ? "This handoff was generated automatically and has not been confirmed by the user." : "This handoff was confirmed by the user.",
    handoff.body_markdown,
    `Current state at close: ${handoff.current_state}`,
  ];
  if (handoff.continuation_guidance) parts.push(`Continuation guidance: ${handoff.continuation_guidance}`);
  if (handoff.open_loops?.length) parts.push(`Open context: ${handoff.open_loops.join("; ")}`);
  if (tailMessages.length) {
    parts.push([
      "Previous window tail transcript (preserve tone and references; do not answer it again):",
      ...tailMessages.map(({ role, content }) => `${role}: ${content}`),
    ].join("\n"));
  }
  return parts.join("\n\n");
}

function buildHandoffPrompt({ summary, messages }) {
  const transcript = (messages || []).map(({ role, content }) => `${role}: ${content}`).join("\n\n");
  return [
    "Create a factual handoff candidate for continuing this AI-companion relationship in a new chat window.",
    "Return JSON only. Do not invent feelings, agreements, events, or unfinished topics.",
    "Summarize what happened in this window, agreements actually reached, unfinished topics, and the current emotional/practical state at the end.",
    "continuation_guidance should help the companion resume naturally without forcing old topics or pretending the new window is the same transcript.",
    'Schema: {"body_markdown":"","current_state":"","topics":[""],"open_loops":[""],"continuation_guidance":""}',
    `Earlier window summary (may be empty):\n${summary || "(none)"}`,
    `Recent source transcript:\n${transcript || "(none)"}`,
  ].join("\n\n");
}

function parseHandoffCandidate(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text);
  const bodyMarkdown = String(parsed.body_markdown || "").trim().slice(0, 12000);
  const currentState = String(parsed.current_state || "").trim().slice(0, 3000);
  if (!bodyMarkdown || !currentState) throw new Error("Handoff candidate is incomplete");
  const strings = (value, limit, max) => [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().slice(0, max)).filter(Boolean))].slice(0, limit);
  return {
    bodyMarkdown,
    currentState,
    topics: strings(parsed.topics, 20, 160),
    openLoops: strings(parsed.open_loops, 20, 300),
    continuationGuidance: String(parsed.continuation_guidance || "").trim().slice(0, 3000),
  };
}

module.exports = { buildHandoffPrompt, formatWindowContinuity, parseHandoffCandidate };
