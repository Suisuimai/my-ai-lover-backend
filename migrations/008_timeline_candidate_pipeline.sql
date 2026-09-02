-- Practice 1: Claude export batches and reviewable timeline candidates.
alter table public.user_settings add column if not exists timeline_model text not null default 'deepseek-v4-flash';

create table if not exists public.conversation_imports (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade, title text not null,
  source_filename text not null, source_metadata jsonb not null default '{}', message_count integer not null,
  character_count integer not null, segment_count integer not null, status text not null default 'ready'
    check (status in ('ready','processing','complete','deleted')), created_at timestamptz not null default now()
);

create table if not exists public.imported_conversation_segments (
  id uuid primary key default gen_random_uuid(), import_id uuid not null references public.conversation_imports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, character_id uuid not null references public.characters(id) on delete cascade,
  sequence integer not null, started_at timestamptz not null, ended_at timestamptz not null,
  message_count integer not null, character_count integer not null, raw_messages jsonb not null,
  cleaned_transcript text not null, status text not null default 'pending'
    check (status in ('pending','generated','skipped')), created_at timestamptz not null default now(), unique(import_id,sequence)
);

create table if not exists public.timeline_candidates (
  id uuid primary key default gen_random_uuid(), segment_id uuid not null references public.imported_conversation_segments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, character_id uuid not null references public.characters(id) on delete cascade,
  title text not null, body_markdown text not null, current_state text not null, index_summary text not null,
  evidence_quotes text[] not null default '{}', evidence_terms text[] not null default '{}', status text not null default 'suggested'
    check(status in ('suggested','confirmed','rejected')), model text not null,
  timeline_entry_id uuid references public.timeline_entries(id) on delete set null,
  created_at timestamptz not null default now(), reviewed_at timestamptz
);

create index if not exists imported_segments_import_sequence_idx on public.imported_conversation_segments(import_id,sequence);
create index if not exists timeline_candidates_user_status_idx on public.timeline_candidates(user_id,status,created_at desc);
alter table public.conversation_imports enable row level security;
alter table public.imported_conversation_segments enable row level security;
alter table public.timeline_candidates enable row level security;
drop policy if exists "Users manage their conversation imports" on public.conversation_imports;
create policy "Users manage their conversation imports" on public.conversation_imports for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "Users manage their imported segments" on public.imported_conversation_segments;
create policy "Users manage their imported segments" on public.imported_conversation_segments for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "Users manage their timeline candidates" on public.timeline_candidates;
create policy "Users manage their timeline candidates" on public.timeline_candidates for all using(auth.uid()=user_id) with check(auth.uid()=user_id);

-- Verification: all results should be 0.
select count(*) as invalid_import_ownership from public.conversation_imports i join public.characters c on c.id=i.character_id where i.user_id<>c.user_id;
select count(*) as invalid_segment_ownership from public.imported_conversation_segments s join public.conversation_imports i on i.id=s.import_id where s.user_id<>i.user_id or s.character_id<>i.character_id;
select count(*) as invalid_candidate_ownership from public.timeline_candidates c join public.imported_conversation_segments s on s.id=c.segment_id where c.user_id<>s.user_id or c.character_id<>s.character_id;
