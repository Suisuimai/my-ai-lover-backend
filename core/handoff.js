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

module.exports = { formatWindowContinuity };
