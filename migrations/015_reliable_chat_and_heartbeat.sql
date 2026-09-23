-- V1 foundation: reliable chat retries and companion heartbeat delivery.

create table if not exists public.chat_requests (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete cascade,
  user_message_id uuid references public.messages(id) on delete set null,
  assistant_message_id uuid references public.messages(id) on delete set null,
  request_text text not null check (char_length(request_text) between 1 and 50000),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists chat_requests_user_time_idx
  on public.chat_requests(user_id, created_at desc);

create table if not exists public.heartbeat_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  enabled boolean not null default false,
  timezone text not null default 'Asia/Shanghai',
  quiet_start time not null default '00:30',
  quiet_end time not null default '07:00',
  min_inactive_minutes integer not null default 120 check (min_inactive_minutes between 30 and 1440),
  min_interval_minutes integer not null default 120 check (min_interval_minutes between 30 and 1440),
  max_interval_minutes integer not null default 210 check (max_interval_minutes between 30 and 1440),
  daily_max integer not null default 7 check (daily_max between 1 and 12),
  inactive_daily_max integer not null default 3 check (inactive_daily_max between 1 and 12),
  show_full_notification boolean not null default true,
  last_chat_at timestamptz,
  last_sent_at timestamptz,
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_interval_minutes >= min_interval_minutes)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

create index if not exists push_subscriptions_user_enabled_idx
  on public.push_subscriptions(user_id, enabled);

create table if not exists public.heartbeat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  content text,
  status text not null default 'scheduled' check (status in ('scheduled', 'generating', 'sent', 'failed', 'skipped')),
  scheduled_at timestamptz not null default now(),
  generated_at timestamptz,
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists heartbeat_messages_user_time_idx
  on public.heartbeat_messages(user_id, created_at desc);

alter table public.chat_requests enable row level security;
alter table public.heartbeat_settings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.heartbeat_messages enable row level security;

drop policy if exists "Users manage their chat requests" on public.chat_requests;
create policy "Users manage their chat requests"
  on public.chat_requests for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage their heartbeat settings" on public.heartbeat_settings;
create policy "Users manage their heartbeat settings"
  on public.heartbeat_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage their push subscriptions" on public.push_subscriptions;
create policy "Users manage their push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users read their heartbeat messages" on public.heartbeat_messages;
create policy "Users read their heartbeat messages"
  on public.heartbeat_messages for select
  using (auth.uid() = user_id);

-- Verification: the result must be 0 before deploying the matching API code.
select count(*) as invalid_v1_foundation
from (
  select user_id from public.heartbeat_settings
  where max_interval_minutes < min_interval_minutes
     or daily_max < inactive_daily_max
  union all
  select user_id from public.chat_requests
  where status not in ('pending', 'succeeded', 'failed')
) invalid;

-- Rollback (only before the feature is used):
-- drop table if exists public.heartbeat_messages;
-- drop table if exists public.push_subscriptions;
-- drop table if exists public.heartbeat_settings;
-- drop table if exists public.chat_requests;
