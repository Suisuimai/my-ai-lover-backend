const { supabase } = require("./db");

const DEFAULT_SESSION_NAME = "New conversation";

function textUpdate(body, key, maxLength = 4000) {
  return typeof body[key] === "string" ? body[key].trim().slice(0, maxLength) : undefined;
}

function limitedStrings(value, limit = 20, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim())
    .filter(Boolean).map((item) => item.slice(0, maxLength)))].slice(0, limit);
}

async function ownedMessageIds(value, sessionId, limit = 20) {
  const ids = limitedStrings(value, limit, 64);
  if (!ids.length) return [];
  if (!sessionId) {
    const error = new Error("Source messages require an owned source session");
    error.status = 400;
    throw error;
  }
  const { data, error } = await supabase.from("messages").select("id")
    .eq("session_id", sessionId).in("id", ids);
  if (error) throw error;
  if ((data || []).length !== ids.length) {
    const ownershipError = new Error("Every source message must belong to the source session");
    ownershipError.status = 400;
    throw ownershipError;
  }
  return ids;
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

module.exports = { DEFAULT_SESSION_NAME, textUpdate, limitedStrings, ownedMessageIds, validUuid };
