-- API and model work, phase 2: user-defined connections and per-feature routes.
-- Existing settings and model_credentials remain untouched for compatibility.

create table if not exists public.api_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 80),
  base_url text not null check (base_url ~ '^https://'),
  encrypted_key text not null,
  api_format text not null check (api_format in ('openai_compatible', 'anthropic')),
  notes text not null default '' check (char_length(notes) <= 1000),
  enabled boolean not null default true,
  legacy_provider text check (legacy_provider in ('deepseek', 'openai', 'anthropic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index if not exists api_connections_user_label_unique_idx
  on public.api_connections(user_id, lower(label));
create unique index if not exists api_connections_legacy_provider_unique_idx
  on public.api_connections(user_id, legacy_provider)
  where legacy_provider is not null;

create table if not exists public.api_feature_routes (
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in (
    'companion_chat', 'conversation_summary', 'conversation_title',
    'followup_interpretation', 'long_term_memory_extraction',
    'timeline_generation', 'embedding'
  )),
  connection_id uuid not null,
  model_id text not null check (char_length(trim(model_id)) between 1 and 300),
  follows_purpose text check (follows_purpose in (
    'companion_chat', 'conversation_summary', 'conversation_title',
    'followup_interpretation', 'long_term_memory_extraction',
    'timeline_generation', 'embedding'
  )),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, purpose),
  foreign key (connection_id, user_id)
    references public.api_connections(id, user_id) on delete restrict,
  check (follows_purpose is null or follows_purpose <> purpose)
);

create index if not exists api_feature_routes_connection_idx
  on public.api_feature_routes(connection_id);

-- Keep a following route as a separate row while copying its source assignment.
create or replace function public.sync_following_api_feature_routes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.api_feature_routes
  set connection_id = new.connection_id,
      model_id = new.model_id,
      updated_at = now()
  where user_id = new.user_id
    and follows_purpose = new.purpose
    and purpose <> new.purpose;
  return new;
end;
$$;

drop trigger if exists sync_following_api_feature_routes_trigger on public.api_feature_routes;
create trigger sync_following_api_feature_routes_trigger
after insert or update of connection_id, model_id on public.api_feature_routes
for each row when (new.follows_purpose is null)
execute function public.sync_following_api_feature_routes();

alter table public.api_connections enable row level security;
alter table public.api_feature_routes enable row level security;

-- These tables are deliberately server-only. The backend uses the service role
-- and exposes safe views that never return encrypted_key.

-- Safely copy existing encrypted credentials into one legacy connection each.
insert into public.api_connections (
  user_id, label, base_url, encrypted_key, api_format, notes, legacy_provider
)
select credential.user_id,
       case credential.provider
         when 'deepseek' then '原 DeepSeek 连接'
         when 'openai' then '原 OpenAI 连接'
         when 'anthropic' then '原 Anthropic 连接'
       end,
       case credential.provider
         when 'deepseek' then 'https://api.deepseek.com'
         when 'openai' then 'https://api.openai.com/v1'
         when 'anthropic' then 'https://api.anthropic.com'
       end,
       credential.encrypted_key,
       case when credential.provider = 'anthropic' then 'anthropic' else 'openai_compatible' end,
       '由旧版 API 设置自动迁移；旧配置仍保留。',
       credential.provider
from public.model_credentials credential
on conflict (user_id, legacy_provider) where legacy_provider is not null do nothing;

-- Migrate direct assignments first. Users relying only on server environment
-- keys receive no route yet and continue through the legacy fallback.
insert into public.api_feature_routes (user_id, purpose, connection_id, model_id)
select settings.user_id, route.purpose, connection.id, route.model_id
from public.user_settings settings
cross join lateral (values
  ('companion_chat', settings.model),
  ('conversation_title', settings.model),
  ('conversation_summary', settings.summary_model),
  ('followup_interpretation', settings.summary_model),
  ('long_term_memory_extraction', settings.summary_model),
  ('timeline_generation', coalesce(settings.timeline_model, settings.summary_model))
) route(purpose, model_id)
join public.api_connections connection
  on connection.user_id = settings.user_id
 and connection.legacy_provider = case
   when route.model_id like 'deepseek-%' then 'deepseek'
   when route.model_id like 'claude-%' then 'anthropic'
   when route.model_id ~ '^(gpt-|o[1-9]|chatgpt-)' then 'openai'
 end
on conflict (user_id, purpose) do nothing;

update public.api_feature_routes follower
set follows_purpose = case follower.purpose
  when 'conversation_title' then 'companion_chat'
  when 'conversation_summary' then 'long_term_memory_extraction'
  when 'followup_interpretation' then 'long_term_memory_extraction'
end
where follower.follows_purpose is null
  and follower.purpose in ('conversation_title', 'conversation_summary', 'followup_interpretation');

-- Link future ledger entries to connections while preserving old rows.
do $$ begin
  alter table public.api_usage_events
    add constraint api_usage_events_connection_fk
    foreign key (connection_id) references public.api_connections(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- Verification: all results should be 0.
select count(*) as invalid_route_ownership
from public.api_feature_routes route
join public.api_connections connection on connection.id = route.connection_id
where route.user_id <> connection.user_id;

select count(*) as invalid_following_route_assignment
from public.api_feature_routes follower
join public.api_feature_routes source
  on source.user_id = follower.user_id and source.purpose = follower.follows_purpose
where follower.connection_id <> source.connection_id
   or follower.model_id <> source.model_id;

-- Rollback before application code depends on these tables:
-- alter table public.api_usage_events drop constraint if exists api_usage_events_connection_fk;
-- drop trigger if exists sync_following_api_feature_routes_trigger on public.api_feature_routes;
-- drop function if exists public.sync_following_api_feature_routes();
-- drop table if exists public.api_feature_routes;
-- drop table if exists public.api_connections;
