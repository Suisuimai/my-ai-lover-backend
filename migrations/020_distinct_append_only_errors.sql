-- Keep append-only diagnostics specific to the table that rejected the update.
create or replace function public.reject_derived_artifact_event_update()
returns trigger language plpgsql as $$
begin
  raise exception 'derived_artifact_events is append-only; append a correction or retraction instead';
end;
$$;

drop trigger if exists derived_artifact_events_no_update on public.derived_artifact_events;
create trigger derived_artifact_events_no_update
before update on public.derived_artifact_events
for each row execute function public.reject_derived_artifact_event_update();

-- Verification: every result should be 0.
select count(*) as invalid_derived_append_only_trigger
from information_schema.triggers
where event_object_schema='public'
  and event_object_table='derived_artifact_events'
  and trigger_name='derived_artifact_events_no_update'
  and action_statement not ilike '%reject_derived_artifact_event_update%';
