function prepareMessagesForProvider(messages, { providerName, model } = {}) {
  const useAnthropicCache = providerName === "openrouter"
    && typeof model === "string"
    && model.startsWith("anthropic/");

  return (messages || []).map(({ cacheBoundary, ...message }) => {
    if (!useAnthropicCache || !cacheBoundary || typeof message.content !== "string") {
      return message;
    }

    return {
      ...message,
      content: [{
        type: "text",
        text: message.content,
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
    };
  });
}

module.exports = { prepareMessagesForProvider };
