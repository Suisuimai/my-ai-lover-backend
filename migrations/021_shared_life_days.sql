-- Diary phase 1: append-only boundaries for one shared life day (morning to bedtime).
create table if not exists public.shared_life_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  day_key date not null,
  created_at timestamptz not null default now(),
  unique(user_id,character_id,day_key)
);

create table if not exists public.shared_life_day_versions (
  id uuid primary key default gen_random_uuid(),
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  revision_number integer not null check(revision_number >= 0),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  source_message_ids uuid[] not null check(cardinality(source_message_ids) > 0),
  first_source_message_id uuid not null references public.source_messages(id),
  last_source_message_id uuid not null references public.source_messages(id),
  morning_marker_source_id uuid references public.source_messages(id),
  night_marker_source_id uuid references public.source_messages(id),
  boundary_state text not null check(boundary_state in ('open','sealed')),
  boundary_reason text not null check(boundary_reason in ('awaiting_end','night_marker','next_shared_day')),
  supersedes_version_id uuid references public.shared_life_day_versions(id),
  created_at timestamptz not null default now(),
  unique(shared_day_id,revision_number)
);

create index if not exists shared_life_days_owner_date_idx
  on public.shared_life_days(user_id,character_id,day_key desc);
create index if not exists shared_life_day_versions_latest_idx
  on public.shared_life_day_versions(shared_day_id,revision_number desc);

create or replace function public.validate_shared_life_day_version()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists (
    select 1 from public.shared_life_days day
    where day.id=new.shared_day_id and day.user_id=new.user_id and day.character_id=new.character_id
  ) then
    raise exception 'Shared-day version must belong to the same user and companion';
  end if;
  if exists (
    select 1 from unnest(new.source_message_ids) source_id
    where not exists (
      select 1 from public.source_messages source
      where source.id=source_id and source.user_id=new.user_id and source.character_id=new.character_id
    )
  ) then
    raise exception 'Every shared-day source must be an owned immutable source message';
  end if;
  if not (new.first_source_message_id=any(new.source_message_ids)
    and new.last_source_message_id=any(new.source_message_ids)
    and (new.morning_marker_source_id is null or new.morning_marker_source_id=any(new.source_message_ids))
    and (new.night_marker_source_id is null or new.night_marker_source_id=any(new.source_message_ids))) then
    raise exception 'Shared-day boundaries must point inside their immutable source set';
  end if;
  if new.revision_number=0 and new.supersedes_version_id is not null then
    raise exception 'The first shared-day version cannot supersede another version';
  end if;
  if new.revision_number>0 and not exists (
    select 1 from public.shared_life_day_versions previous
    where previous.id=new.supersedes_version_id and previous.shared_day_id=new.shared_day_id
      and previous.revision_number=new.revision_number-1
  ) then
    raise exception 'A shared-day revision must append to the immediately previous version';
  end if;
  return new;
end;
$$;

create or replace function public.reject_shared_life_day_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'shared_life_day_versions is append-only; append a new version instead';
end;
$$;

drop trigger if exists shared_life_day_versions_validate on public.shared_life_day_versions;
create trigger shared_life_day_versions_validate
before insert on public.shared_life_day_versions
for each row execute function public.validate_shared_life_day_version();

drop trigger if exists shared_life_day_versions_no_update on public.shared_life_day_versions;
create trigger shared_life_day_versions_no_update
before update on public.shared_life_day_versions
for each row execute function public.reject_shared_life_day_version_update();

alter table public.shared_life_days enable row level security;
alter table public.shared_life_day_versions enable row level security;
drop policy if exists "Users read their shared life days" on public.shared_life_days;
create policy "Users read their shared life days" on public.shared_life_days
  for select using(auth.uid()=user_id);
drop policy if exists "Users read their shared life day history" on public.shared_life_day_versions;
create policy "Users read their shared life day history" on public.shared_life_day_versions
  for select using(auth.uid()=user_id);

-- Verification: every result should be 0.
select count(*) as invalid_shared_day_sources
from public.shared_life_day_versions version
cross join lateral unnest(version.source_message_ids) source_id
where not exists (
  select 1 from public.source_messages source
  where source.id=source_id and source.user_id=version.user_id and source.character_id=version.character_id
);

select count(*) as invalid_shared_day_boundaries
from public.shared_life_day_versions version
where not (version.first_source_message_id=any(version.source_message_ids)
  and version.last_source_message_id=any(version.source_message_ids)
  and (version.morning_marker_source_id is null or version.morning_marker_source_id=any(version.source_message_ids))
  and (version.night_marker_source_id is null or version.night_marker_source_id=any(version.source_message_ids)));

select count(*) as invalid_shared_day_revision_chain
from public.shared_life_day_versions version
where (version.revision_number=0 and version.supersedes_version_id is not null)
   or (version.revision_number>0 and not exists (
     select 1 from public.shared_life_day_versions previous
     where previous.id=version.supersedes_version_id and previous.shared_day_id=version.shared_day_id
       and previous.revision_number=version.revision_number-1
   ));
