const net = require("node:net");

const API_FORMATS = new Set(["openai_compatible", "anthropic"]);
const FEATURE_PURPOSES = new Set([
  "companion_chat",
  "conversation_summary",
  "conversation_title",
  "followup_interpretation",
  "long_term_memory_extraction",
  "timeline_generation",
  "embedding",
]);

function isPrivateIp(address) {
  const plain = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(plain) === 4) {
    const [a, b] = plain.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (net.isIP(plain) === 6) {
    if (plain === "::" || plain === "::1" || plain.startsWith("fc") || plain.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(plain)) return true;
    if (plain.startsWith("::ffff:")) return isPrivateIp(plain.slice(7));
  }
  return false;
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Connection URL is not valid");
  }
  if (parsed.protocol !== "https:") throw new Error("Connection URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Connection URL cannot contain credentials");
  if (parsed.search || parsed.hash) throw new Error("Connection URL cannot contain a query or fragment");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIp(hostname)) {
    throw new Error("Connection URL cannot point to a local or private address");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function modelEndpoint(baseUrl, apiFormat) {
  if (!API_FORMATS.has(apiFormat)) throw new Error("Unsupported API format");
  const normalized = normalizeBaseUrl(baseUrl);
  if (apiFormat === "anthropic") {
    return normalized.endsWith("/messages") ? normalized : `${normalized}/v1/messages`;
  }
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function legacyProviderForModel(model) {
  const value = String(model || "");
  if (value.startsWith("deepseek-")) return "deepseek";
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(value)) return "openai";
  if (value.startsWith("claude-")) return "anthropic";
  return null;
}

function connectionKind(connection) {
  const hostname = new URL(normalizeBaseUrl(connection?.base_url)).hostname.toLowerCase();
  if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) return "openrouter";
  if (hostname === "api.deepseek.com") return "deepseek";
  if (hostname === "api.openai.com") return "openai";
  if (hostname === "api.anthropic.com") return "anthropic";
  return "custom";
}

function safeConnectionView(connection) {
  return {
    id: connection.id,
    label: connection.label,
    baseUrl: connection.base_url,
    apiFormat: connection.api_format,
    notes: connection.notes || "",
    enabled: connection.enabled,
    hasApiKey: Boolean(connection.encrypted_key),
    createdAt: connection.created_at,
    updatedAt: connection.updated_at,
  };
}

module.exports = {
  API_FORMATS,
  FEATURE_PURPOSES,
  connectionKind,
  isPrivateIp,
  legacyProviderForModel,
  modelEndpoint,
  normalizeBaseUrl,
  safeConnectionView,
};
