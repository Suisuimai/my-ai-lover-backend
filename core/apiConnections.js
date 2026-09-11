const net = require("node:net");

const API_FORMATS = new Set(["openai_compatible", "anthropic"]);
// Register model-backed jobs here. The frontend reads this catalog from the backend,
// while each purpose still has to be wired to a real callModel() call before use.
const FEATURE_DEFINITIONS = [
  { id: "companion_chat", name: "伴侣聊天", description: "生成每次正式回复" },
  { id: "long_term_memory_extraction", name: "记忆提取", description: "批量读取对话，提取事件、证据与候选文档", recommendation: "建议使用便宜模型" },
  { id: "memory_verification", name: "记忆校验与合并", description: "检查失真并合并 Knowledge File", recommendation: "建议使用较强模型" },
  { id: "timeline_generation", name: "候选日记", description: "整理导入的 Claude 对话" },
  { id: "conversation_title", name: "窗口标题", description: "默认跟随伴侣聊天", follows: "companion_chat" },
  { id: "conversation_summary", name: "窗口摘要", description: "默认跟随记忆提取", follows: "long_term_memory_extraction" },
  { id: "followup_interpretation", name: "Followup 判断", description: "默认跟随记忆提取", follows: "long_term_memory_extraction" },
  { id: "embedding", name: "语义检索", description: "为未来的语义召回生成向量", hidden: true },
];
const FEATURE_PURPOSES = new Set(FEATURE_DEFINITIONS.map((feature) => feature.id));

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

function modelCatalogEndpoint(baseUrl, apiFormat) {
  if (!API_FORMATS.has(apiFormat)) throw new Error("Unsupported API format");
  const normalized = normalizeBaseUrl(baseUrl);
  if (apiFormat === "anthropic") {
    if (normalized.endsWith("/v1/messages")) return `${normalized.slice(0, -"/messages".length)}/models`;
    if (normalized.endsWith("/v1")) return `${normalized}/models`;
    return `${normalized}/v1/models`;
  }
  if (normalized.endsWith("/chat/completions")) return `${normalized.slice(0, -"/chat/completions".length)}/models`;
  return `${normalized}/models`;
}

function normalizeModelCatalog(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : [];
  return rows.map((item) => {
    const id = typeof item === "string" ? item : item?.id || item?.name;
    if (!id) return null;
    const name = item?.name || item?.display_name || id;
    return { id: String(id), name: String(name) };
  }).filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((left, right) => left.name.localeCompare(right.name));
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
  FEATURE_DEFINITIONS,
  FEATURE_PURPOSES,
  connectionKind,
  isPrivateIp,
  legacyProviderForModel,
  modelCatalogEndpoint,
  modelEndpoint,
  normalizeModelCatalog,
  normalizeBaseUrl,
  safeConnectionView,
};
