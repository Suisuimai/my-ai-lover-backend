-- Chat controls: cancellation, partial replies, and reply alternatives.

alter table public.chat_requests
  drop constraint if exists chat_requests_status_check;

alter table public.chat_requests
  add constraint chat_requests_status_check
  check (status in ('pending', 'succeeded', 'failed', 'cancelled'));

alter table public.chat_requests
  add column if not exists partial_content text;

alter table public.messages
  add column if not exists context_status text not null default 'active'
  check (context_status in ('active', 'alternative', 'discarded'));

alter table public.messages
  add column if not exists replaces_message_id uuid references public.messages(id) on delete set null;

create index if not exists messages_session_context_idx
  on public.messages(session_id, context_status, created_at);

select count(*) as invalid_chat_controls
from public.messages
where context_status not in ('active', 'alternative', 'discarded');
