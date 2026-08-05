# V2 foundation baseline

## Current data ownership

- `sessions.user_id` owns a conversation.
- `messages` and `session_memories` inherit ownership through `session_id`.
- `user_settings` and `model_credentials` are keyed by `user_id`.
- Row-level security is enabled; the backend also verifies bearer tokens and
  session ownership.

## Current conversation context

The model receives, in order:

1. the user's `system_prompt`;
2. the current session's rolling summary, when present;
3. the most recent visible messages.

`session_memories` remains a window-level summary in V2. It will not be reused
as the cross-window long-term memory store.

## Compatibility requirements for V2

- Existing sessions, messages, summaries, user settings, and credentials must
  survive every migration.
- Existing sessions will be assigned to a per-user default character.
- New character and memory tables must be scoped by user and character.
- Deleted, archived, or superseded memories must never enter model context.
- Long-term-memory extraction failures must not block the visible chat reply.

## Baseline verification

- `node --check index.js`
- `npm test`
- Frontend `npm run lint`
- Frontend `npm run build`
