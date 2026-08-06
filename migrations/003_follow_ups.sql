-- V3 relationship continuity: user-controlled unfinished topics.

create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  title text not null,
  kind text not null default 'plan'
    check (kind in ('plan', 'promise', 'waiting_result', 'paused_topic')),
  content text not null,
  status text not null default 'active'
    check (status in ('active', 'waiting', 'completed', 'cancelled', 'paused')),
  due_at timestamptz,
  next_step text not null default '',
  triggers text[] not null default '{}',
  allow_proactive boolean not null default false,
  last_followed_up_at timestamptz,
  source_session_id uuid references public.sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists follow_ups_character_status_updated_idx
  on public.follow_ups (character_id, status, updated_at desc);
create index if not exists follow_ups_user_idx on public.follow_ups (user_id);
create index if not exists follow_ups_triggers_gin_idx on public.follow_ups using gin (triggers);
create index if not exists follow_ups_due_idx
  on public.follow_ups (due_at) where status in ('active', 'waiting');

alter table public.follow_ups enable row level security;
drop policy if exists "own follow ups" on public.follow_ups;
create policy "own follow ups" on public.follow_ups for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

select count(*) as invalid_follow_up_ownership
from public.follow_ups follow_up
join public.characters character on character.id = follow_up.character_id
where follow_up.user_id <> character.user_id;
