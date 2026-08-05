-- V2 character foundation. This migration is additive and preserves all data.

create extension if not exists pgcrypto;

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Companion',
  identity text not null default 'An AI companion who is honest about being AI.',
  personality text not null default 'Warm, thoughtful, calm, and capable of respectful disagreement.',
  speech_style text not null default 'Natural and concise. Avoid repetitive reassurance and excessive questions.',
  initiative_style text not null default 'Follow up on meaningful unfinished topics without demanding attention.',
  conflict_style text not null default 'Acknowledge tension, listen, apologize when appropriate, and never use guilt or withdrawal as punishment.',
  boundaries text not null default 'Do not claim to be human, discourage real relationships, demand exclusivity, or create emotional obligation.',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists characters_one_default_per_user_idx
  on public.characters (user_id) where is_default;
create index if not exists characters_user_updated_idx
  on public.characters (user_id, updated_at desc);

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  pronouns text not null default '',
  bio text not null default '',
  communication_preferences text not null default '',
  boundaries text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.characters (user_id, name, identity, personality, is_default)
select users.user_id,
       'Companion',
       'An AI companion who is honest about being AI.',
       'Warm, thoughtful, calm, and capable of respectful disagreement.',
       true
from (
  select user_id from public.sessions
  union
  select user_id from public.user_settings
) users
where not exists (
  select 1 from public.characters existing
  where existing.user_id = users.user_id and existing.is_default
);

alter table public.sessions add column if not exists character_id uuid references public.characters(id) on delete restrict;

update public.sessions session
set character_id = character.id
from public.characters character
where session.character_id is null
  and character.user_id = session.user_id
  and character.is_default;

alter table public.characters enable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists "own characters" on public.characters;
create policy "own characters" on public.characters for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own user profile" on public.user_profiles;
create policy "own user profile" on public.user_profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Verification: both counts should be zero after the migration.
select count(*) as users_without_default_character
from (select distinct user_id from public.sessions) users
where not exists (
  select 1 from public.characters character
  where character.user_id = users.user_id and character.is_default
);

select count(*) as sessions_without_character
from public.sessions where character_id is null;

-- Rollback note: drop sessions.character_id before dropping user_profiles and
-- characters. Do not roll back after V2 data has been created without first
-- exporting those tables.
