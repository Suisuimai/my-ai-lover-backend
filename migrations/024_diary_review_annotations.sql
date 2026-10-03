-- Append-only user review and annotation history for grounded diaries.
create table if not exists public.diary_review_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  diary_entry_id uuid not null references public.diary_entries(id) on delete cascade,
  event_kind text not null check(event_kind in (
    'fact_confirmed','fact_excluded','fact_corrected','entry_confirmed','entry_confirmation_revoked',
    'factual_note_added','relationship_note_added'
  )),
  scope text not null check(scope in ('fact','entry','annotation')),
  issue_index integer check(issue_index is null or issue_index >= 0),
  anchor_kind text not null default 'entry' check(anchor_kind in ('entry','sentence')),
  anchor_text text,
  content text,
  replacement_text text,
  provenance text not null check(provenance in ('original_messages','user_later_confirmation','relationship_note')),
  source_message_ids uuid[] not null default '{}',
  result_entry_id uuid references public.diary_entries(id),
  supersedes_event_id uuid references public.diary_review_events(id),
  batch_id uuid,
  created_at timestamptz not null default now(),
  check(anchor_kind <> 'sentence' or nullif(trim(anchor_text),'') is not null),
  check(event_kind not in ('factual_note_added','relationship_note_added') or nullif(trim(content),'') is not null)
);

create index if not exists diary_review_events_owner_day_idx
  on public.diary_review_events(user_id,character_id,shared_day_id,created_at,id);
create index if not exists diary_review_events_batch_idx
  on public.diary_review_events(user_id,batch_id) where batch_id is not null;

create or replace function public.validate_diary_review_event()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists (
    select 1 from public.diary_entries entry
    where entry.id=new.diary_entry_id and entry.user_id=new.user_id
      and entry.character_id=new.character_id and entry.shared_day_id=new.shared_day_id
  ) then
    raise exception 'Diary review must belong to an owned diary entry';
  end if;
  if exists (
    select 1 from unnest(new.source_message_ids) source_id
    where not exists (
      select 1 from public.source_messages source
      where source.id=source_id and source.user_id=new.user_id and source.character_id=new.character_id
    )
  ) then
    raise exception 'Diary review cited an unowned source message';
  end if;
  if new.supersedes_event_id is not null and not exists (
    select 1 from public.diary_review_events previous
    where previous.id=new.supersedes_event_id and previous.user_id=new.user_id
      and previous.character_id=new.character_id and previous.shared_day_id=new.shared_day_id
  ) then
    raise exception 'Diary review retraction must stay in the same shared day';
  end if;
  return new;
end;
$$;

create or replace function public.reject_diary_review_event_update()
returns trigger language plpgsql as $$
begin
  raise exception 'diary_review_events is append-only; append a new review event instead';
end;
$$;

drop trigger if exists diary_review_events_validate on public.diary_review_events;
create trigger diary_review_events_validate before insert on public.diary_review_events
for each row execute function public.validate_diary_review_event();
drop trigger if exists diary_review_events_no_update on public.diary_review_events;
create trigger diary_review_events_no_update before update on public.diary_review_events
for each row execute function public.reject_diary_review_event_update();

alter table public.diary_review_events enable row level security;
drop policy if exists "Users read their diary review history" on public.diary_review_events;
create policy "Users read their diary review history" on public.diary_review_events
  for select using(auth.uid()=user_id);

create or replace function public.append_diary_review(
  p_event_id uuid,
  p_user_id uuid,
  p_entry_id uuid,
  p_event_kind text,
  p_scope text,
  p_issue_index integer,
  p_anchor_kind text,
  p_anchor_text text,
  p_content text,
  p_replacement_text text,
  p_provenance text,
  p_source_message_ids uuid[],
  p_supersedes_event_id uuid,
  p_batch_id uuid,
  p_result_entry_id uuid,
  p_result_status text,
  p_result_body_markdown text,
  p_result_validation_issues jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  source_entry public.diary_entries%rowtype;
begin
  select * into source_entry from public.diary_entries
  where id=p_entry_id and user_id=p_user_id;
  if source_entry.id is null then raise exception 'Diary entry not found'; end if;

  if p_result_entry_id is not null then
    insert into public.diary_entries (
      id,user_id,character_id,shared_day_id,shared_day_version_id,generation_job_id,status,
      title,body_markdown,current_state,source_message_ids,validation_issues,supersedes_entry_id
    ) values (
      p_result_entry_id,source_entry.user_id,source_entry.character_id,source_entry.shared_day_id,
      source_entry.shared_day_version_id,source_entry.generation_job_id,p_result_status,
      source_entry.title,p_result_body_markdown,source_entry.current_state,source_entry.source_message_ids,
      p_result_validation_issues,source_entry.id
    );
  end if;

  insert into public.diary_review_events (
    id,user_id,character_id,shared_day_id,diary_entry_id,event_kind,scope,issue_index,
    anchor_kind,anchor_text,content,replacement_text,provenance,source_message_ids,
    result_entry_id,supersedes_event_id,batch_id
  ) values (
    p_event_id,source_entry.user_id,source_entry.character_id,source_entry.shared_day_id,source_entry.id,
    p_event_kind,p_scope,p_issue_index,coalesce(p_anchor_kind,'entry'),p_anchor_text,p_content,
    p_replacement_text,p_provenance,coalesce(p_source_message_ids,'{}'),p_result_entry_id,
    p_supersedes_event_id,p_batch_id
  );
  return jsonb_build_object('event_id',p_event_id,'entry_id',p_result_entry_id);
end;
$$;

revoke all on function public.append_diary_review(uuid,uuid,uuid,text,text,integer,text,text,text,text,text,uuid[],uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.append_diary_review(uuid,uuid,uuid,text,text,integer,text,text,text,text,text,uuid[],uuid,uuid,uuid,text,text,jsonb) to service_role;

-- Verification: every result should be 0.
select count(*) as invalid_diary_review_ownership
from public.diary_review_events review
where not exists (
  select 1 from public.diary_entries entry
  where entry.id=review.diary_entry_id and entry.user_id=review.user_id
    and entry.character_id=review.character_id and entry.shared_day_id=review.shared_day_id
);
select count(*) as invalid_diary_review_result
from public.diary_review_events review
where review.result_entry_id is not null and not exists (
  select 1 from public.diary_entries entry
  where entry.id=review.result_entry_id and entry.supersedes_entry_id=review.diary_entry_id
);

-- Rollback: drop the RPC, triggers and diary_review_events table. Diary entry versions already appended
-- by reviews must be exported before any rollback; never delete them blindly in production.
