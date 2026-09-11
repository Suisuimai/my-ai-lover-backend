-- Add the strong-model memory verification/document merge route.
-- No existing connection or route is changed.

alter table public.api_feature_routes
  drop constraint if exists api_feature_routes_purpose_check;
alter table public.api_feature_routes
  add constraint api_feature_routes_purpose_check check (purpose in (
    'companion_chat', 'conversation_summary', 'conversation_title',
    'followup_interpretation', 'long_term_memory_extraction',
    'memory_verification', 'timeline_generation', 'embedding'
  ));

alter table public.api_feature_routes
  drop constraint if exists api_feature_routes_follows_purpose_check;
alter table public.api_feature_routes
  add constraint api_feature_routes_follows_purpose_check check (follows_purpose in (
    'companion_chat', 'conversation_summary', 'conversation_title',
    'followup_interpretation', 'long_term_memory_extraction',
    'memory_verification', 'timeline_generation', 'embedding'
  ));

select count(*) as invalid_memory_verification_routes
from public.api_feature_routes
where purpose = 'memory_verification'
  and (connection_id is null or nullif(trim(model_id), '') is null);
