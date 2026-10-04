function normalizeCompletion(providerType, finishReason, terminalSeen) {
  const reason = String(finishReason || "").toLowerCase();
  if (["stop", "end_turn", "stop_sequence"].includes(reason)) return { complete: true, status: "complete", finishReason: reason };
  if (["length", "max_tokens"].includes(reason)) return { complete: false, status: "length", finishReason: reason };
  if (!terminalSeen) return { complete: false, status: "abnormal_eof", finishReason: reason || null };
  return { complete: false, status: "unknown", finishReason: reason || null };
}

async function readModelEventStream(response, { providerType, onDelta = () => {} }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finalData = {};
  let terminalSeen = false;
  let finishReason = null;

  const processBlock = (block) => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      if (raw === "[DONE]") { terminalSeen = true; continue; }
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      if (data.usage) finalData = { ...finalData, ...data, usage: { ...(finalData.usage || {}), ...data.usage } };
      else {
        if (data.id) finalData.id = data.id;
        if (data.model) finalData.model = data.model;
      }
      const delta = providerType === "anthropic"
        ? (data.type === "content_block_delta" ? data.delta?.text : "")
        : data.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onDelta(delta, text); }
      if (providerType === "anthropic") {
        if (data.type === "message_start") finalData = { ...finalData, ...(data.message || {}) };
        if (data.type === "message_delta") {
          finalData = { ...finalData, usage: { ...(finalData.usage || {}), ...(data.usage || {}) } };
          if (data.delta?.stop_reason) { finishReason = data.delta.stop_reason; terminalSeen = true; }
        }
        if (data.type === "message_stop") terminalSeen = true;
      } else if (data.choices?.[0]?.finish_reason) {
        finishReason = data.choices[0].finish_reason;
        terminalSeen = true;
      }
    }
  };

  const drain = (flush = false) => {
    buffer = buffer.replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    const tail = blocks.pop() || "";
    buffer = flush ? "" : tail;
    for (const block of blocks) if (block.trim()) processBlock(block);
    if (flush && tail.trim()) processBlock(tail);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  return { text: text.trim(), data: finalData, completion: normalizeCompletion(providerType, finishReason, terminalSeen) };
}

module.exports = { normalizeCompletion, readModelEventStream };
