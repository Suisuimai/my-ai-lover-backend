# Real chat timing

`POST /chat` stores a JSON array in the existing
`api_usage_events.provider_usage.preparation_breakdown`. No migration or
environment setting is required. This is not prompt-preview instrumentation.

Each entry contains only `stage`, `ms`, and `success`. Timings use
`performance.now()`, starting before authentication. No request text, prompt,
source text, credentials, or error details enter the breakdown.

- Operation stages measure their own elapsed duration. Settings, profiles,
  history, and recall can overlap; do not add their durations to estimate total
  latency.
- `model_routing` measures the chat model-route/connection lookup, started as
  soon as settings are available, overlapping request persistence and context
  preparation. No model request is sent until preparation succeeds.
- `upstream_request` measures any remaining wait for model routing, message
  preparation, and HTTP request through response headers, not the entire
  generation. Routing is not repeated when the prefetched result is consumed.
- `upstream_first_token`, `first_sse_data`, and `round_complete` are milestones
  measured from authentication start. First token means first visible text
  delta, not an upstream heartbeat, reasoning delta, or role event.
- `first_sse_data` is the first successful server `res.write()` of an SSE event.
  It does not prove arrival or rendering in the PWA. Normally this is a delta;
  on failure it can be an error event.
- `semantic_rrf` measures semantic RPC and local ranking separately and records
  their combined sequential duration, excluding embedding. With semantic recall
  disabled, only local ranking runs.
- Unexecuted stages are `ms: 0, success: false`; this does not mean an embedding
  request failed. Semantic recall remains disabled on the chat hot path.
- `round_complete.success` is false for errors, cancellation, and truncation.

`preparation_ms` retains its route-entry-to-model-call definition.
`first_token_ms` now includes authentication and equals the first-token
milestone. `duration_ms` remains model-call duration. All durations use the
monotonic clock; ledger date timestamps still use wall time.
The three SQL integer columns truncate elapsed milliseconds; the JSON
breakdown keeps fractional precision.

Context reads start only after current message persistence or edit/regenerate
mutations. They no longer wait for request linkage and heartbeat completion,
but both are still awaited before generation. Diary/annotation reads overlap
version/exact-source reads, preserving diary confirmation gates, source IDs,
partial-range disclosure, and pointer persistence after successful assembly.
BM25/RRF rules, revision validity checks, prompt content, and cache boundaries
are unchanged.

For chat, model usage is collected by `callModel()` and inserted once after the
route finishes, with the complete breakdown attached. Insertion is best-effort
and is not awaited by the chat response. A failed or stalled insert does not
break chat. As with other best-effort writes, process termination can lose an
in-flight insert. Other model purposes keep their existing ledger path.

Requests that never call a model (validation failures or idempotent completed
retries) do not create an extra model-usage event. No new logging system or
synthetic billing event is introduced.
