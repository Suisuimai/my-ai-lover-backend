-- V4 foundation: typed knowledge files, timeline journals, window handoffs,
-- version history, and a retraction ledger. This migration is additive.

alter table public.prompt_documents
  add column if not exists document_type text not null default 'topic';
alter table public.prompt_documents
  add column if not exists load_mode text not null default 'always';
alter table public.prompt_documents
  add column if not exists confirmation_status text not null default 'confirmed';
alter table public.prompt_documents
  add column if not exists created_by text not null default 'user';
alter table public.prompt_documents
  add column if not exists version integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'prompt_documents_type_check') then
    alter table public.prompt_documents add constraint prompt_documents_type_check
      check (document_type in ('core', 'memory_protocol', 'topic', 'archive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prompt_documents_load_mode_check') then
    alter table public.prompt_documents add constraint prompt_documents_load_mode_check
      check (load_mode in ('always', 'on_demand', 'archive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prompt_documents_confirmation_check') then
    alter table public.prompt_documents add constraint prompt_documents_confirmation_check
      check (confirmation_status in ('confirmed', 'suggested'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prompt_documents_created_by_check') then
    alter table public.prompt_documents add constraint prompt_documents_created_by_check
      check (created_by in ('user', 'ai'));
  end if;
end $$;

update public.prompt_documents
set load_mode = case when is_enabled then 'always' else 'archive' end
where load_mode = 'always' and not is_enabled;

create table if not exists public.prompt_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.prompt_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  name text not null,
  content text not null,
  document_type text not null,
  load_mode text not null,
  change_reason text not null default '',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

create index if not exists prompt_document_versions_document_idx
  on public.prompt_document_versions(document_id, version desc);

insert into public.prompt_document_versions (
  document_id, user_id, version, name, content, document_type, load_mode, created_by
)
select id, user_id, version, name, content, document_type, load_mode, created_by
from public.prompt_documents
on conflict (document_id, version) do nothing;

create or replace function public.set_prompt_document_version()
returns trigger language plpgsql as $$
begin
  if row(new.name, new.content, new.document_type, new.load_mode, new.confirmation_status)
     is distinct from
     row(old.name, old.content, old.document_type, old.load_mode, old.confirmation_status) then
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.snapshot_prompt_document_version()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.prompt_document_versions (
      document_id, user_id, version, name, content, document_type, load_mode, created_by
    ) values (
      new.id, new.user_id, new.version, new.name, new.content,
      new.document_type, new.load_mode, new.created_by
    ) on conflict (document_id, version) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists prompt_documents_set_version on public.prompt_documents;
create trigger prompt_documents_set_version
before update on public.prompt_documents
for each row execute function public.set_prompt_document_version();

drop trigger if exists prompt_documents_snapshot_version on public.prompt_documents;
create trigger prompt_documents_snapshot_version
after insert or update on public.prompt_documents
for each row execute function public.snapshot_prompt_document_version();

create table if not exists public.timeline_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  source_session_id uuid references public.sessions(id) on delete set null,
  title text not null check (char_length(title) between 1 and 160),
  body_markdown text not null check (char_length(body_markdown) between 1 and 20000),
  current_state text not null check (char_length(current_state) between 1 and 3000),
  index_summary text not null check (char_length(index_summary) between 1 and 1200),
  evidence_terms text[] not null default '{}',
  source_message_ids uuid[] not null default '{}',
  occurred_at timestamptz not null default now(),
  status text not null default 'active'
    check (status in ('active', 'retracted', 'deleted')),
  confirmation_status text not null default 'auto'
    check (confirmation_status in ('auto', 'confirmed')),
  created_by text not null default 'ai'
    check (created_by in ('user', 'ai')),
  recall_count integer not null default 0,
  last_recalled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists timeline_entries_character_status_time_idx
  on public.timeline_entries(character_id, status, occurred_at desc);
create index if not exists timeline_entries_evidence_gin_idx
  on public.timeline_entries using gin(evidence_terms);

create table if not exists public.timeline_retractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  timeline_entry_id uuid not null references public.timeline_entries(id) on delete cascade,
  replacement_entry_id uuid references public.timeline_entries(id) on delete set null,
  quote text not null check (char_length(quote) between 2 and 2000),
  reason text not null check (char_length(reason) between 2 and 2000),
  created_at timestamptz not null default now(),
  unique (timeline_entry_id)
);

create index if not exists timeline_retractions_character_idx
  on public.timeline_retractions(character_id, created_at desc);

create table if not exists public.session_handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  source_session_id uuid references public.sessions(id) on delete set null,
  body_markdown text not null check (char_length(body_markdown) between 1 and 12000),
  current_state text not null check (char_length(current_state) between 1 and 3000),
  topics text[] not null default '{}',
  open_loops text[] not null default '{}',
  continuation_guidance text not null default '',
  tail_message_ids uuid[] not null default '{}',
  status text not null default 'auto'
    check (status in ('auto', 'confirmed', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists session_handoffs_character_time_idx
  on public.session_handoffs(character_id, status, created_at desc);

alter table public.prompt_document_versions enable row level security;
alter table public.timeline_entries enable row level security;
alter table public.timeline_retractions enable row level security;
alter table public.session_handoffs enable row level security;

drop policy if exists "Users manage their prompt document versions" on public.prompt_document_versions;
create policy "Users manage their prompt document versions"
  on public.prompt_document_versions for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and exists (
      select 1 from public.prompt_documents document
      where document.id = prompt_document_versions.document_id
        and document.user_id = auth.uid()
    )
  );

drop policy if exists "Users manage their timeline entries" on public.timeline_entries;
create policy "Users manage their timeline entries"
  on public.timeline_entries for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and exists (
      select 1 from public.characters character
      where character.id = timeline_entries.character_id
        and character.user_id = auth.uid()
    )
  );

drop policy if exists "Users manage their timeline retractions" on public.timeline_retractions;
create policy "Users manage their timeline retractions"
  on public.timeline_retractions for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and exists (
      select 1 from public.timeline_entries entry
      where entry.id = timeline_retractions.timeline_entry_id
        and entry.user_id = auth.uid()
        and entry.character_id = timeline_retractions.character_id
    )
  );

drop policy if exists "Users manage their session handoffs" on public.session_handoffs;
create policy "Users manage their session handoffs"
  on public.session_handoffs for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and exists (
      select 1 from public.characters character
      where character.id = session_handoffs.character_id
        and character.user_id = auth.uid()
    )
  );

-- Verification: every result should be 0.
select count(*) as invalid_timeline_ownership
from public.timeline_entries entry
join public.characters character on character.id = entry.character_id
where entry.user_id <> character.user_id;

select count(*) as invalid_handoff_ownership
from public.session_handoffs handoff
join public.characters character on character.id = handoff.character_id
where handoff.user_id <> character.user_id;

select count(*) as invalid_retraction_ownership
from public.timeline_retractions retraction
join public.timeline_entries entry on entry.id = retraction.timeline_entry_id
where retraction.user_id <> entry.user_id
   or retraction.character_id <> entry.character_id;

-- Rollback note: drop the three new V4 tables and prompt_document_versions,
-- then remove the five added prompt_documents columns only after exporting them.
