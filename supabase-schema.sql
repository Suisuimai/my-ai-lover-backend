-- Run this once in Supabase SQL Editor before deploying the updated API.

alter table public.sessions
  add column if not exists updated_at timestamptz not null default now();

update public.sessions
set updated_at = coalesce(updated_at, created_at, now())
where updated_at is null;

alter table public.messages
  add column if not exists is_visible boolean not null default true;

create table if not exists public.session_memories (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  summary text not null,
  last_compressed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.session_memories
  add column if not exists last_compressed_at timestamptz;

create table if not exists public.app_settings (
  id smallint primary key default 1 check (id = 1),
  system_prompt text not null default 'You are a warm, thoughtful AI companion. Respond naturally and supportively.',
  model text not null default 'deepseek-v4-flash',
  temperature numeric not null default 0.8 check (temperature >= 0 and temperature <= 2),
  max_tokens integer not null default 800 check (max_tokens > 0),
  context_token_threshold integer not null default 6000 check (context_token_threshold > 0),
  recent_message_limit integer not null default 12 check (recent_message_limit >= 2),
  summary_model text not null default 'deepseek-v4-flash',
  updated_at timestamptz not null default now()
);

alter table public.app_settings
  add column if not exists context_token_threshold integer not null default 6000;

alter table public.app_settings
  add column if not exists recent_message_limit integer not null default 12;

alter table public.app_settings
  add column if not exists summary_model text not null default 'deepseek-v4-flash';

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

create index if not exists sessions_updated_at_idx
  on public.sessions (updated_at desc);

create index if not exists messages_session_visible_created_at_idx
  on public.messages (session_id, is_visible, created_at asc);

-- Replace the existing foreign key so session deletion also deletes messages.
alter table public.messages
  drop constraint if exists messages_session_id_fkey;

alter table public.messages
  add constraint messages_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;
