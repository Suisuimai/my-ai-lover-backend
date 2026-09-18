-- Bind a newly created conversation to the confirmed handoff it started from.
-- Back up public.sessions before applying this migration.

alter table public.sessions
  add column if not exists handoff_id uuid references public.session_handoffs(id) on delete set null;

create index if not exists sessions_handoff_idx
  on public.sessions(user_id, handoff_id)
  where handoff_id is not null;

-- Verification: both results must be 0.
select count(*) as invalid_session_handoff_owner
from public.sessions session
join public.session_handoffs handoff on handoff.id = session.handoff_id
where session.user_id <> handoff.user_id;

select count(*) as invalid_session_handoff_character
from public.sessions session
join public.session_handoffs handoff on handoff.id = session.handoff_id
where session.character_id <> handoff.character_id;

-- Rollback after exporting the binding if needed:
-- drop index if exists public.sessions_handoff_idx;
-- alter table public.sessions drop column if exists handoff_id;
