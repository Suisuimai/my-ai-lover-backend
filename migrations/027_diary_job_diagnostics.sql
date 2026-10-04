-- Safe, structured diagnostics for asynchronous diary generation jobs.
alter table public.diary_generation_jobs
  add column if not exists failure_stage text,
  add column if not exists requested_model text,
  add column if not exists source_message_count integer;

update public.diary_generation_jobs job
set source_message_count=cardinality(version.source_message_ids)
from public.shared_life_day_versions version
where job.shared_day_version_id=version.id and job.source_message_count is null;

alter table public.diary_generation_jobs
  drop constraint if exists diary_generation_jobs_failure_stage_check;
alter table public.diary_generation_jobs
  add constraint diary_generation_jobs_failure_stage_check check (
    failure_stage is null or failure_stage in ('source_read','model_request','model_parse','validation','storage')
  );

alter table public.diary_generation_jobs
  drop constraint if exists diary_generation_jobs_source_message_count_check;
alter table public.diary_generation_jobs
  add constraint diary_generation_jobs_source_message_count_check check (
    source_message_count is null or source_message_count >= 0
  );

-- Verification (expected: 0):
-- select count(*) from public.diary_generation_jobs
-- where source_message_count is null;
-- Rollback note: these nullable diagnostic columns may be dropped only after the
-- deployed backend and frontend no longer read or write them. No source, diary,
-- or review rows are changed or removed by this migration.
