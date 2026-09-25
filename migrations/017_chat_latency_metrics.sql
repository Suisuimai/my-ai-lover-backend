-- Measure the two delays a user actually feels: context preparation and first token.

alter table public.api_usage_events
  add column if not exists preparation_ms integer
  check (preparation_ms is null or preparation_ms >= 0);

alter table public.api_usage_events
  add column if not exists first_token_ms integer
  check (first_token_ms is null or first_token_ms >= 0);

select count(*) as invalid_latency_metrics
from public.api_usage_events
where preparation_ms < 0 or first_token_ms < 0;
