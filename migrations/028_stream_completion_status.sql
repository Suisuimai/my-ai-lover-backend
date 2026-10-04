-- Preserve incomplete model output while keeping its terminal state visible and append-only.
alter table public.api_usage_events
  drop constraint if exists api_usage_events_status_check;
alter table public.api_usage_events
  add constraint api_usage_events_status_check check (status in ('succeeded','failed','truncated'));
alter table public.api_usage_events
  add column if not exists completion_status text
  check (completion_status is null or completion_status in ('complete','length','abnormal_eof','unknown'));
alter table public.api_usage_events
  add column if not exists finish_reason text;

alter table public.chat_requests
  drop constraint if exists chat_requests_status_check;
alter table public.chat_requests
  add constraint chat_requests_status_check
  check (status in ('pending','succeeded','failed','cancelled','truncated'));

alter table public.messages
  add column if not exists generation_status text not null default 'complete'
  check (generation_status in ('complete','stopped','truncated_length','truncated_eof','truncated_unknown'));
alter table public.messages
  add column if not exists finish_reason text;
alter table public.messages
  add column if not exists continues_message_id uuid references public.messages(id) on delete set null;

create index if not exists messages_continuation_idx on public.messages(continues_message_id)
  where continues_message_id is not null;

-- Verification: every result should be 0.
select count(*) as invalid_stream_completion_rows from public.messages
where generation_status not in ('complete','stopped','truncated_length','truncated_eof','truncated_unknown');

-- Rollback: remove the added columns/index, then restore the previous status constraints.
