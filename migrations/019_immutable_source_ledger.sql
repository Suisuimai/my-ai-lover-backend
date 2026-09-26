-- Immutable source-of-truth ledger for live and imported conversation messages.
-- Routine edits append revisions; they never erase the original text.

create table if not exists public.source_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  source_kind text not null check (source_kind in ('live_chat','claude_import')),
  revision_kind text not null default 'original' check (revision_kind in ('original','correction')),
  role text not null check (role in ('user','assistant','system')),
  raw_content text not null,
  occurred_at timestamptz not null,
  session_id uuid references public.sessions(id) on delete cascade,
  import_id uuid references public.conversation_imports(id) on delete cascade,
  imported_segment_id uuid references public.imported_conversation_segments(id) on delete cascade,
  operational_message_id uuid,
  supersedes_source_message_id uuid,
  revision_number integer not null default 0 check (revision_number >= 0),
  source_position integer,
  segment_message_index integer,
  source_metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (
    (source_kind='live_chat' and session_id is not null and import_id is null)
    or (source_kind='claude_import' and import_id is not null and session_id is null)
  )
);

create unique index if not exists source_messages_live_revision_idx
  on public.source_messages(operational_message_id,revision_number)
  where operational_message_id is not null;
create unique index if not exists source_messages_import_position_idx
  on public.source_messages(import_id,source_position)
  where import_id is not null and source_position is not null;
create unique index if not exists source_messages_segment_position_idx
  on public.source_messages(imported_segment_id,segment_message_index)
  where imported_segment_id is not null and segment_message_index is not null;
create index if not exists source_messages_owner_time_idx
  on public.source_messages(user_id,character_id,occurred_at,id);

create or replace function public.reject_source_message_update()
returns trigger language plpgsql as $$
begin
  raise exception 'source_messages is append-only; append a correction instead';
end;
$$;

drop trigger if exists source_messages_no_update on public.source_messages;
create trigger source_messages_no_update
before update on public.source_messages
for each row execute function public.reject_source_message_update();

create or replace function public.archive_live_message_revision()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  owner_id uuid;
  companion_id uuid;
  previous_source public.source_messages%rowtype;
begin
  select session.user_id,session.character_id into owner_id,companion_id
  from public.sessions session where session.id=new.session_id;
  if owner_id is null or companion_id is null then return new; end if;

  if tg_op='INSERT' then
    insert into public.source_messages (
      user_id,character_id,source_kind,revision_kind,role,raw_content,occurred_at,
      session_id,operational_message_id,revision_number,source_metadata
    ) values (
      owner_id,companion_id,'live_chat','original',new.role,new.content,new.created_at,
      new.session_id,new.id,0,jsonb_build_object('captured_by','messages_trigger')
    ) on conflict (operational_message_id,revision_number) where operational_message_id is not null do nothing;
  elsif new.content is distinct from old.content then
    select * into previous_source from public.source_messages
    where operational_message_id=new.id order by revision_number desc limit 1;
    insert into public.source_messages (
      user_id,character_id,source_kind,revision_kind,role,raw_content,occurred_at,
      session_id,operational_message_id,supersedes_source_message_id,revision_number,source_metadata
    ) values (
      owner_id,companion_id,'live_chat','correction',new.role,new.content,now(),
      new.session_id,new.id,previous_source.id,coalesce(previous_source.revision_number,-1)+1,
      jsonb_build_object('captured_by','messages_trigger','original_message_created_at',new.created_at)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists messages_archive_source_revision on public.messages;
create trigger messages_archive_source_revision
after insert or update of content on public.messages
for each row execute function public.archive_live_message_revision();

-- Preserve the current live corpus. Earlier overwritten revisions cannot be reconstructed.
insert into public.source_messages (
  user_id,character_id,source_kind,revision_kind,role,raw_content,occurred_at,
  session_id,operational_message_id,revision_number,source_metadata
)
select session.user_id,session.character_id,'live_chat','original',message.role,message.content,message.created_at,
       message.session_id,message.id,0,jsonb_build_object('legacy_backfill',true)
from public.messages message
join public.sessions session on session.id=message.session_id
where session.character_id is not null
on conflict (operational_message_id,revision_number) where operational_message_id is not null do nothing;

-- Preserve every existing imported raw message as its own addressable source row.
insert into public.source_messages (
  user_id,character_id,source_kind,revision_kind,role,raw_content,occurred_at,
  import_id,imported_segment_id,revision_number,source_position,segment_message_index,source_metadata
)
select segment.user_id,segment.character_id,'claude_import','original',item.value->>'role',item.value->>'content',
       coalesce((item.value->>'time')::timestamptz,segment.started_at),segment.import_id,segment.id,0,
       segment.sequence*100000+item.ordinality::integer,item.ordinality::integer,
       jsonb_build_object('legacy_backfill',true,'segment_sequence',segment.sequence)
from public.imported_conversation_segments segment
cross join lateral jsonb_array_elements(segment.raw_messages) with ordinality item(value,ordinality)
on conflict (imported_segment_id,segment_message_index)
  where imported_segment_id is not null and segment_message_index is not null do nothing;

-- Append-only home for future objective indexes, diary layers, annotations, and corrections.
create table if not exists public.derived_artifact_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  artifact_kind text not null check (artifact_kind in ('objective_index','diary_fact','diary_feeling','user_annotation')),
  artifact_key uuid not null,
  event_kind text not null default 'created' check (event_kind in ('created','corrected','retracted')),
  body jsonb not null,
  source_message_ids uuid[] not null,
  supersedes_event_id uuid,
  created_at timestamptz not null default now(),
  check (cardinality(source_message_ids) > 0)
);

create index if not exists derived_artifacts_owner_key_idx
  on public.derived_artifact_events(user_id,character_id,artifact_key,created_at,id);

create or replace function public.validate_derived_artifact_sources()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists (
    select 1 from unnest(new.source_message_ids) source_id
    where not exists (
      select 1 from public.source_messages source
      where source.id=source_id and source.user_id=new.user_id and source.character_id=new.character_id
    )
  ) then
    raise exception 'Every derived artifact must cite owned immutable source message IDs';
  end if;
  if new.event_kind in ('corrected','retracted') and not exists (
    select 1 from public.derived_artifact_events previous
    where previous.id=new.supersedes_event_id and previous.user_id=new.user_id
      and previous.character_id=new.character_id and previous.artifact_key=new.artifact_key
  ) then
    raise exception 'Corrections and retractions must append to the same artifact history';
  end if;
  return new;
end;
$$;

drop trigger if exists derived_artifact_events_validate_sources on public.derived_artifact_events;
create trigger derived_artifact_events_validate_sources
before insert on public.derived_artifact_events
for each row execute function public.validate_derived_artifact_sources();

drop trigger if exists derived_artifact_events_no_update on public.derived_artifact_events;
create trigger derived_artifact_events_no_update
before update on public.derived_artifact_events
for each row execute function public.reject_source_message_update();

alter table public.source_messages enable row level security;
alter table public.derived_artifact_events enable row level security;
drop policy if exists "Users read immutable source messages" on public.source_messages;
create policy "Users read immutable source messages" on public.source_messages
  for select using(auth.uid()=user_id);
drop policy if exists "Users read derived artifact history" on public.derived_artifact_events;
create policy "Users read derived artifact history" on public.derived_artifact_events
  for select using(auth.uid()=user_id);

-- Verification: every result should be 0.
select count(*) as live_messages_without_source_id
from public.messages message
join public.sessions session on session.id=message.session_id
where session.character_id is not null and not exists (
  select 1 from public.source_messages source
  where source.operational_message_id=message.id and source.revision_number=0
);

select count(*) as imported_messages_without_source_id
from public.imported_conversation_segments segment
cross join lateral jsonb_array_elements(segment.raw_messages) with ordinality item(value,ordinality)
where not exists (
  select 1 from public.source_messages source
  where source.imported_segment_id=segment.id and source.segment_message_index=item.ordinality
);

select count(*) as invalid_derived_source_reference
from public.derived_artifact_events event
cross join lateral unnest(event.source_message_ids) source_id
where not exists (
  select 1 from public.source_messages source
  where source.id=source_id and source.user_id=event.user_id and source.character_id=event.character_id
);

-- Rollback: remove the two archive triggers first, then the archive tables and functions.
-- Do not roll back after new diary/index work begins without exporting both tables.
