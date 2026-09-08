-- API and model work, phase 1: append-only usage ledger.
-- No prompt, response, or API-key content is stored here.
create table if not exists public.api_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid,
  purpose text not null default 'unspecified',
  provider text,
  requested_model text not null,
  resolved_model text,
  status text not null check (status in ('succeeded', 'failed')),
  http_status integer,
  error_code text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  cache_write_1h_tokens bigint not null default 0 check (cache_write_1h_tokens >= 0),
  cache_hit_tokens bigint not null default 0 check (cache_hit_tokens >= 0),
  cache_miss_tokens bigint not null default 0 check (cache_miss_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  provider_cost numeric(20, 10),
  estimated_cost numeric(20, 10),
  cost_currency text,
  cost_source text not null default 'unavailable'
    check (cost_source in ('provider_reported', 'estimated', 'unavailable')),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  provider_request_id text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  provider_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists api_usage_events_user_time_idx
  on public.api_usage_events(user_id, started_at desc);
create index if not exists api_usage_events_user_purpose_time_idx
  on public.api_usage_events(user_id, purpose, started_at desc);
create index if not exists api_usage_events_user_provider_time_idx
  on public.api_usage_events(user_id, provider, started_at desc);

alter table public.api_usage_events enable row level security;

-- The signed-in user may inspect their ledger. Writes are server-only because
-- the service-role backend records authoritative usage events.
drop policy if exists "Users read their API usage" on public.api_usage_events;
create policy "Users read their API usage"
  on public.api_usage_events for select
  using (auth.uid() = user_id);

-- Verification: should return 0.
select count(*) as invalid_api_usage_rows
from public.api_usage_events
where completed_at < started_at
   or (status = 'succeeded' and http_status is not null and http_status >= 400);

-- Rollback before application code depends on this table:
-- drop table if exists public.api_usage_events;
