const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareMessagesForProvider } = require("../core/promptCaching");

test("adds a one-hour OpenRouter Anthropic cache breakpoint to the fixed document boundary", () => {
  const result = prepareMessagesForProvider([
    { role: "system", content: "Instructions" },
    { role: "system", content: "Four fixed documents", cacheBoundary: true },
    { role: "system", content: "Current time" },
  ], { providerName: "openrouter", model: "anthropic/claude-sonnet-4.5" });

  assert.deepEqual(result, [
    { role: "system", content: "Instructions" },
    {
      role: "system",
      content: [{
        type: "text",
        text: "Four fixed documents",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
    },
    { role: "system", content: "Current time" },
  ]);
});

test("strips internal cache metadata for providers that do not use this cache format", () => {
  assert.deepEqual(prepareMessagesForProvider([
    { role: "system", content: "Fixed documents", cacheBoundary: true },
  ], { providerName: "openrouter", model: "deepseek/deepseek-chat" }), [
    { role: "system", content: "Fixed documents" },
  ]);
});
