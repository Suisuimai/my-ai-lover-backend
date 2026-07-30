-- Run once after deploying the authenticated backend. Existing demo data is discarded.
delete from public.messages;
delete from public.session_memories;
delete from public.sessions;

alter table public.sessions add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.sessions alter column user_id set not null;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  system_prompt text not null default 'You are a warm, thoughtful AI companion.',
  model text not null default 'deepseek-v4-flash',
  temperature numeric not null default 0.8 check (temperature >= 0 and temperature <= 2),
  max_tokens integer not null default 800 check (max_tokens > 0),
  context_token_threshold integer not null default 6000 check (context_token_threshold > 0),
  recent_message_limit integer not null default 12 check (recent_message_limit >= 2),
  summary_model text not null default 'deepseek-v4-flash',
  updated_at timestamptz not null default now()
);

-- API keys are encrypted by the backend before being stored here.  Do not grant
-- browser clients direct policies for this table: the authenticated backend is
-- the only reader, and it never returns encrypted_key to the client.
create table if not exists public.model_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('deepseek', 'openai', 'anthropic')),
  encrypted_key text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.sessions enable row level security;
alter table public.messages enable row level security;
alter table public.session_memories enable row level security;
alter table public.user_settings enable row level security;
alter table public.model_credentials enable row level security;

drop policy if exists "own sessions" on public.sessions;
drop policy if exists "own messages" on public.messages;
drop policy if exists "own memories" on public.session_memories;
drop policy if exists "own settings" on public.user_settings;
create policy "own sessions" on public.sessions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own messages" on public.messages for all using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())) with check (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));
create policy "own memories" on public.session_memories for all using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())) with check (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));
create policy "own settings" on public.user_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
