const { performance } = require("node:perf_hooks");

// Only this allowlist can reach the usage ledger. Never accept request data.
const STAGES = [
  "authentication", "session_load", "request_lookup", "request_persistence",
  "user_message_persistence", "request_linkage", "heartbeat_reset",
  "settings", "character", "user_profile", "recent_history", "prompt_documents",
  "continuity", "long_term_memories", "followups", "memory_summary",
  "bm25_lexical", "embedding_request", "semantic_rrf", "diary_source_assembly",
  "prompt_assembly", "upstream_request", "upstream_first_token",
  "first_sse_data", "round_complete",
];

function createChatTiming(now = () => performance.now()) {
  const origin = now();
  const values = new Map();
  const elapsed = (start) => Math.max(0, now() - start);
  const put = (stage, start, success) => {
    if (!STAGES.includes(stage)) throw new Error("Unknown timing stage");
    const previous = values.get(stage);
    values.set(stage, {
      stage,
      ms: (previous?.ms || 0) + elapsed(start),
      success: (previous?.success ?? true) && Boolean(success),
    });
  };
  return {
    elapsed: () => elapsed(origin),
    start(stage) {
      const start = now();
      let ended = false;
      return (success = true) => {
        if (!ended) { put(stage, start, success); ended = true; }
      };
    },
    async measure(stage, work) {
      const end = this.start(stage);
      try {
        const result = await work();
        end(!result?.error);
        return result;
      } catch (error) { end(false); throw error; }
    },
    mark(stage, success = true) {
      if (!values.has(stage)) put(stage, origin, success);
      return values.get(stage).ms;
    },
    snapshot() {
      return STAGES.map((stage) => values.get(stage) || { stage, ms: 0, success: false });
    },
  };
}

function persistChatUsage(event, timing, write) {
  if (!event) return;
  const safeEvent = {
    ...event,
    provider_usage: {
      ...event.provider_usage,
      preparation_breakdown: timing.snapshot(),
    },
  };
  // A stalled or failed ledger write must never delay the response.
  void Promise.resolve().then(() => write(safeEvent)).catch(() => {});
}

module.exports = { createChatTiming, persistChatUsage };
