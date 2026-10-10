const DEFAULT_INTERVAL_MS = 55 * 60 * 1000;
const DEFAULT_WINDOW_MS = 3 * 60 * 60 * 1000;

function cachedPrefix(messages) {
  const boundary = (messages || []).findIndex((message) => message.cacheBoundary);
  if (boundary < 0) return null;
  return messages.slice(0, boundary + 1).map((message) => ({ ...message }));
}

function usageTouchedCache(event) {
  return Boolean(event)
    && event.status !== "failed"
    && ((event.cache_read_tokens || 0) > 0 || (event.cache_write_tokens || 0) > 0 || (event.cache_write_1h_tokens || 0) > 0);
}

// Pings stay within the window measured from the last real chat, so a user who
// walks away stops costing anything after the window plus one cache lifetime.
function createCacheKeepAlive({
  send,
  intervalMs = DEFAULT_INTERVAL_MS,
  windowMs = DEFAULT_WINDOW_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map();

  function schedule(key, entry) {
    const fireAt = (entry.lastFiredAt ?? entry.lastActivityAt) + intervalMs;
    if (fireAt - entry.lastActivityAt > windowMs) {
      entries.delete(key);
      return;
    }
    entry.timer = setTimer(() => fire(key, entry), Math.max(0, fireAt - now()));
    entry.timer?.unref?.();
  }

  async function fire(key, entry) {
    if (entries.get(key) !== entry) return;
    entry.lastFiredAt = now();
    try {
      await send(entry.payload);
    } catch {
      console.error("Prompt cache keep-alive failed");
    }
    if (entries.get(key) === entry) schedule(key, entry);
  }

  function touch(key, payload) {
    if (!key || !payload) return;
    cancel(key);
    const entry = { payload, lastActivityAt: now(), lastFiredAt: null, timer: null };
    entries.set(key, entry);
    schedule(key, entry);
  }

  function cancel(key) {
    const existing = entries.get(key);
    if (existing?.timer) clearTimer(existing.timer);
    entries.delete(key);
  }

  return { touch, cancel, size: () => entries.size };
}

module.exports = { cachedPrefix, createCacheKeepAlive, usageTouchedCache, DEFAULT_INTERVAL_MS, DEFAULT_WINDOW_MS };
