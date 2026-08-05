-- Cross-window long-term memories.
--
-- Compatibility note: the production database already has a legacy
-- public.memories table used for per-session summaries. Keep those columns and
-- rows intact, then add the V2 long-term-memory columns alongside them.

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.memories add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.memories add column if not exists character_id uuid references public.characters(id) on delete cascade;
alter table public.memories add column if not exists category text;
alter table public.memories add column if not exists content text;
alter table public.memories add column if not exists triggers text[] not null default '{}';
alter table public.memories add column if not exists status text not null default 'active';
alter table public.memories add column if not exists is_permanent boolean not null default false;
alter table public.memories add column if not exists source_session_id uuid references public.sessions(id) on delete set null;
alter table public.memories add column if not exists recall_count integer not null default 0;
alter table public.memories add column if not exists last_recalled_at timestamptz;
alter table public.memories add column if not exists updated_at timestamptz not null default now();

-- Convert legacy session summaries when the old columns are present. Dynamic
-- SQL keeps this migration valid for both a fresh database and the production
-- database's legacy schema.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories' and column_name = 'session_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories' and column_name = 'summary'
  ) then
    execute $backfill$
      update public.memories memory
      set user_id = coalesce(memory.user_id, session.user_id),
          character_id = coalesce(memory.character_id, session.character_id),
          category = coalesce(memory.category, 'relationship'),
          content = coalesce(memory.content, nullif(memory.summary, '')),
          source_session_id = coalesce(memory.source_session_id, memory.session_id),
          updated_at = coalesce(memory.updated_at, memory.created_at, now())
      from public.sessions session
      where session.id = memory.session_id
    $backfill$;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memories_v2_category_check') then
    alter table public.memories add constraint memories_v2_category_check
      check (category is null or category in ('preference', 'important_event', 'promise', 'unfinished', 'relationship'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memories_v2_status_check') then
    alter table public.memories add constraint memories_v2_status_check
      check (status in ('active', 'archived', 'superseded', 'deleted'));
  end if;
end $$;

create index if not exists memories_character_status_updated_idx
  on public.memories (character_id, status, updated_at desc);
create index if not exists memories_user_idx on public.memories (user_id);
create index if not exists memories_triggers_gin_idx on public.memories using gin (triggers);

alter table public.memories enable row level security;
drop policy if exists "own memories v2" on public.memories;
create policy "own memories v2" on public.memories for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Verification: invalid ownership must be zero. Legacy orphan rows may remain
-- with null V2 fields; the V2 backend only recalls rows bound to a character.
select count(*) as invalid_character_ownership
from public.memories memory
join public.characters character on character.id = memory.character_id
where memory.user_id <> character.user_id;

select count(*) as legacy_rows_not_bound_to_v2
from public.memories
where character_id is null or user_id is null or content is null;

-- Rollback note: the original legacy columns and rows are preserved. Export
-- public.memories before removing any V2 columns after the new backend is live.
