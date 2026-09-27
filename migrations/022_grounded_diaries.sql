-- Diary phase 2: asynchronous jobs and append-only, source-grounded diary entries.
alter table public.api_feature_routes
  drop constraint if exists api_feature_routes_purpose_check;
alter table public.api_feature_routes
  add constraint api_feature_routes_purpose_check check (purpose in (
    'companion_chat','conversation_summary','conversation_title','followup_interpretation',
    'long_term_memory_extraction','memory_verification','timeline_generation','diary_generation','embedding'
  ));
alter table public.api_feature_routes
  drop constraint if exists api_feature_routes_follows_purpose_check;
alter table public.api_feature_routes
  add constraint api_feature_routes_follows_purpose_check check (follows_purpose in (
    'companion_chat','conversation_summary','conversation_title','followup_interpretation',
    'long_term_memory_extraction','memory_verification','timeline_generation','diary_generation','embedding'
  ));

insert into public.api_feature_routes (user_id,purpose,connection_id,model_id,follows_purpose,enabled)
select source.user_id,'diary_generation',source.connection_id,source.model_id,'long_term_memory_extraction',source.enabled
from public.api_feature_routes source
where source.purpose='long_term_memory_extraction'
on conflict (user_id,purpose) do nothing;

create table if not exists public.diary_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  shared_day_version_id uuid not null references public.shared_life_day_versions(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','running','succeeded','needs_review','failed')),
  attempt_number integer not null default 1 check(attempt_number > 0),
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  shared_day_version_id uuid not null references public.shared_life_day_versions(id) on delete cascade,
  generation_job_id uuid not null references public.diary_generation_jobs(id) on delete cascade,
  status text not null check(status in ('confirmed','needs_review')),
  title text not null check(char_length(trim(title)) between 1 and 160),
  body_markdown text not null check(char_length(trim(body_markdown)) > 0),
  current_state text not null default '',
  source_message_ids uuid[] not null check(cardinality(source_message_ids) > 0),
  validation_issues jsonb not null default '[]'::jsonb check(jsonb_typeof(validation_issues)='array'),
  supersedes_entry_id uuid references public.diary_entries(id),
  created_at timestamptz not null default now(),
  check(status<>'confirmed' or jsonb_array_length(validation_issues)=0)
);

create index if not exists diary_jobs_owner_status_idx
  on public.diary_generation_jobs(user_id,character_id,status,created_at);
create index if not exists diary_entries_owner_day_idx
  on public.diary_entries(user_id,character_id,shared_day_id,created_at desc);

create or replace function public.validate_grounded_diary_entry()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists (
    select 1 from public.shared_life_day_versions version
    where version.id=new.shared_day_version_id and version.shared_day_id=new.shared_day_id
      and version.user_id=new.user_id and version.character_id=new.character_id
  ) then
    raise exception 'Diary entry must belong to its owned shared-day version';
  end if;
  if exists (
    select 1 from unnest(new.source_message_ids) source_id
    where not exists (
      select 1 from public.source_messages source
      where source.id=source_id and source.user_id=new.user_id and source.character_id=new.character_id
    )
  ) then
    raise exception 'Every diary entry must cite owned immutable source messages';
  end if;
  if not exists (
    select 1 from public.diary_generation_jobs job
    where job.id=new.generation_job_id and job.user_id=new.user_id and job.character_id=new.character_id
      and job.shared_day_id=new.shared_day_id and job.shared_day_version_id=new.shared_day_version_id
  ) then
    raise exception 'Diary entry must belong to its generation job';
  end if;
  if new.supersedes_entry_id is not null and not exists (
    select 1 from public.diary_entries previous
    where previous.id=new.supersedes_entry_id and previous.user_id=new.user_id
      and previous.character_id=new.character_id and previous.shared_day_id=new.shared_day_id
  ) then
    raise exception 'Diary corrections must append to the same shared day';
  end if;
  return new;
end;
$$;

create or replace function public.reject_diary_entry_update()
returns trigger language plpgsql as $$
begin
  raise exception 'diary_entries is append-only; append a corrected entry instead';
end;
$$;

drop trigger if exists diary_entries_validate on public.diary_entries;
create trigger diary_entries_validate before insert on public.diary_entries
for each row execute function public.validate_grounded_diary_entry();
drop trigger if exists diary_entries_no_update on public.diary_entries;
create trigger diary_entries_no_update before update on public.diary_entries
for each row execute function public.reject_diary_entry_update();

alter table public.diary_generation_jobs enable row level security;
alter table public.diary_entries enable row level security;
drop policy if exists "Users read their diary jobs" on public.diary_generation_jobs;
create policy "Users read their diary jobs" on public.diary_generation_jobs
  for select using(auth.uid()=user_id);
drop policy if exists "Users read their grounded diaries" on public.diary_entries;
create policy "Users read their grounded diaries" on public.diary_entries
  for select using(auth.uid()=user_id);

create or replace function public.save_grounded_diary(
  p_entry_id uuid,
  p_user_id uuid,
  p_character_id uuid,
  p_shared_day_id uuid,
  p_shared_day_version_id uuid,
  p_generation_job_id uuid,
  p_status text,
  p_title text,
  p_body_markdown text,
  p_current_state text,
  p_source_message_ids uuid[],
  p_validation_issues jsonb,
  p_facts jsonb,
  p_feelings jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare item jsonb;
begin
  insert into public.diary_entries (
    id,user_id,character_id,shared_day_id,shared_day_version_id,generation_job_id,status,
    title,body_markdown,current_state,source_message_ids,validation_issues
  ) values (
    p_entry_id,p_user_id,p_character_id,p_shared_day_id,p_shared_day_version_id,p_generation_job_id,p_status,
    p_title,p_body_markdown,p_current_state,p_source_message_ids,p_validation_issues
  );
  for item in select value from jsonb_array_elements(coalesce(p_facts,'[]'::jsonb)) loop
    insert into public.derived_artifact_events (
      user_id,character_id,artifact_kind,artifact_key,event_kind,body,source_message_ids
    ) values (
      p_user_id,p_character_id,'diary_fact',gen_random_uuid(),'created',
      jsonb_build_object('diary_entry_id',p_entry_id,'text',item->>'text','claim_class','verified_fact','fact_eligible',true),
      array(select value::uuid from jsonb_array_elements_text(item->'source_message_ids'))
    );
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_feelings,'[]'::jsonb)) loop
    insert into public.derived_artifact_events (
      user_id,character_id,artifact_kind,artifact_key,event_kind,body,source_message_ids
    ) values (
      p_user_id,p_character_id,'diary_feeling',gen_random_uuid(),'created',
      jsonb_build_object('diary_entry_id',p_entry_id,'text',item->>'text','claim_class','companion_feeling','fact_eligible',false),
      array(select value::uuid from jsonb_array_elements_text(item->'source_message_ids'))
    );
  end loop;
  return p_entry_id;
end;
$$;
revoke all on function public.save_grounded_diary(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,uuid[],jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_grounded_diary(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,uuid[],jsonb,jsonb,jsonb) to service_role;

-- Verification: every result should be 0.
select count(*) as invalid_diary_sources
from public.diary_entries entry cross join lateral unnest(entry.source_message_ids) source_id
where not exists (
  select 1 from public.source_messages source
  where source.id=source_id and source.user_id=entry.user_id and source.character_id=entry.character_id
);
select count(*) as invalid_confirmed_diaries
from public.diary_entries
where status='confirmed' and jsonb_array_length(validation_issues)>0;
select count(*) as invalid_diary_job_links
from public.diary_entries entry
where not exists (
  select 1 from public.diary_generation_jobs job
  where job.id=entry.generation_job_id and job.user_id=entry.user_id and job.character_id=entry.character_id
    and job.shared_day_id=entry.shared_day_id and job.shared_day_version_id=entry.shared_day_version_id
);
