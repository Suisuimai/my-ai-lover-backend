-- V3.2 unified follow-up status events and long-term memory provenance.

alter table public.memories
  add column if not exists source_follow_up_id uuid references public.follow_ups(id) on delete set null;

alter table public.memories
  add column if not exists event_status text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memories_follow_up_event_status_check') then
    alter table public.memories add constraint memories_follow_up_event_status_check
      check (event_status is null or event_status in ('active', 'waiting', 'completed', 'paused'));
  end if;
end $$;

create index if not exists memories_source_follow_up_status_idx
  on public.memories (source_follow_up_id, status, updated_at desc)
  where source_follow_up_id is not null;

select count(*) as invalid_follow_up_memory_ownership
from public.memories memory
join public.follow_ups follow_up on follow_up.id = memory.source_follow_up_id
where memory.user_id <> follow_up.user_id
   or memory.character_id <> follow_up.character_id;
