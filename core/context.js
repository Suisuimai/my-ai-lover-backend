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

function buildModelContext({
  systemPrompt,
  promptDocuments,
  characterProfile,
  userProfile,
  currentContext,
  topicDocuments,
  timelineMemories,
  windowContinuity,
  followUps,
  longTermMemories,
  memorySummary,
  recentMessages,
}) {
  return [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...(promptDocuments ? [{ role: "system", content: promptDocuments }] : []),
    ...(characterProfile ? [{ role: "system", content: characterProfile }] : []),
    ...(userProfile ? [{ role: "system", content: userProfile }] : []),
    ...(currentContext ? [{ role: "system", content: currentContext }] : []),
    ...(topicDocuments ? [{ role: "system", content: topicDocuments }] : []),
    ...(timelineMemories ? [{ role: "system", content: timelineMemories }] : []),
    ...(windowContinuity ? [{ role: "system", content: windowContinuity }] : []),
    ...(followUps ? [{ role: "system", content: followUps }] : []),
    ...(longTermMemories ? [{ role: "system", content: longTermMemories }] : []),
    ...(memorySummary
      ? [{ role: "system", content: `Conversation memory summary:\n${memorySummary}` }]
      : []),
    ...recentMessages.map(({ role, content }) => ({ role, content })),
  ];
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 2);
}

function normalizeRecentMessageLimit(limit, fallback = 12) {
  const safeLimit = Math.max(2, Number(limit) || fallback);
  return safeLimit % 2 === 0 ? safeLimit : safeLimit + 1;
}

module.exports = {
  buildModelContext,
  estimateTokens,
  formatCharacterProfile,
  formatUserProfile,
  normalizeRecentMessageLimit,
};
