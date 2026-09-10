const test = require("node:test");
const assert = require("node:assert/strict");
const {
  connectionKind, isPrivateIp, legacyProviderForModel, modelEndpoint, normalizeBaseUrl, safeConnectionView,
} = require("../core/apiConnections");

test("normalizes safe HTTPS base URLs and appends protocol endpoints", () => {
  assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1");
  assert.equal(modelEndpoint("https://openrouter.ai/api/v1", "openai_compatible"), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(modelEndpoint("https://api.deepseek.com/anthropic", "anthropic"), "https://api.deepseek.com/anthropic/v1/messages");
});

test("recognizes gateway capabilities from a connection without exposing providers as cards", () => {
  assert.equal(connectionKind({ base_url: "https://openrouter.ai/api/v1" }), "openrouter");
  assert.equal(connectionKind({ base_url: "https://relay.example.com/v1" }), "custom");
});

test("rejects unsafe connection URLs", () => {
  for (const url of ["http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://192.168.1.2/v1"]) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("maps legacy model IDs without treating gateways as model providers", () => {
  assert.equal(legacyProviderForModel("deepseek-v4-flash"), "deepseek");
  assert.equal(legacyProviderForModel("claude-opus-4-6"), "anthropic");
  assert.equal(legacyProviderForModel("anthropic/claude-opus-4.6"), null);
});

test("connection views never expose encrypted API keys", () => {
  const view = safeConnectionView({
    id: "one", label: "Main", base_url: "https://example.com/v1", api_format: "openai_compatible",
    notes: "", enabled: true, encrypted_key: "ciphertext", created_at: "now", updated_at: "now",
  });
  assert.equal(view.hasApiKey, true);
  assert.equal("encrypted_key" in view, false);
});
