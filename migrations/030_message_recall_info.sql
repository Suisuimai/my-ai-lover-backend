-- Which shared day the companion recalled for this reply and which words of the
-- user's message triggered it, so the user can judge recall quality in the chat.
-- Shape: { "dayKey": "2026-08-03", "mode": "matched" | "continued", "terms": ["跑步机"] }
alter table public.messages add column if not exists recall_info jsonb;

-- Rollback: alter table public.messages drop column if exists recall_info;
