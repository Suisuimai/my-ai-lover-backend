-- Memory Practice 1 foundation. Entirely additive: old Timeline data is untouched.

create table if not exists public.memory_processing_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  import_id uuid not null references public.conversation_imports(id) on delete cascade,
  segment_id uuid not null references public.imported_conversation_segments(id) on delete cascade,
  status text not null default 'extracted' check (status in ('extracted','verified','rejected')),
  extraction_model text not null,
  verification_model text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (segment_id)
);

create table if not exists public.memory_experience_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.memory_processing_batches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  title text not null,
  narrative_markdown text not null,
  current_state text not null,
  index_summary text not null,
  search_anchors jsonb not null,
  evidence_refs jsonb not null,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','verified','needs_revision')),
  verification_notes text not null default '',
  review_status text not null default 'suggested' check (review_status in ('suggested','confirmed','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.memory_knowledge_notes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.memory_processing_batches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  suggested_document_name text not null,
  note_markdown text not null,
  evidence_refs jsonb not null,
  status text not null default 'extracted' check (status in ('extracted','merged','rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.memory_handoff_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.memory_processing_batches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  body_markdown text not null,
  current_state text not null,
  topics text[] not null default '{}',
  open_loops text[] not null default '{}',
  continuation_guidance text not null default '',
  evidence_refs jsonb not null,
  status text not null default 'suggested' check (status in ('suggested','confirmed','rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.memory_knowledge_patch_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.memory_processing_batches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  document_id uuid references public.prompt_documents(id) on delete set null,
  document_name text not null,
  previous_content text not null default '',
  proposed_content text not null,
  change_summary text not null,
  evidence_refs jsonb not null,
  review_status text not null default 'suggested' check (review_status in ('suggested','confirmed','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists memory_batches_user_status_idx on public.memory_processing_batches(user_id,status,created_at desc);
create index if not exists memory_experiences_batch_idx on public.memory_experience_candidates(batch_id,review_status);
create index if not exists memory_notes_batch_idx on public.memory_knowledge_notes(batch_id,status);
create index if not exists memory_handoffs_batch_idx on public.memory_handoff_candidates(batch_id,status);
create index if not exists memory_patches_batch_idx on public.memory_knowledge_patch_candidates(batch_id,review_status);

alter table public.memory_processing_batches enable row level security;
alter table public.memory_experience_candidates enable row level security;
alter table public.memory_knowledge_notes enable row level security;
alter table public.memory_handoff_candidates enable row level security;
alter table public.memory_knowledge_patch_candidates enable row level security;

create policy "Users manage their memory batches" on public.memory_processing_batches for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "Users manage their experience candidates" on public.memory_experience_candidates for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "Users manage their knowledge notes" on public.memory_knowledge_notes for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "Users manage their handoff candidates" on public.memory_handoff_candidates for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "Users manage their knowledge patch candidates" on public.memory_knowledge_patch_candidates for all using(auth.uid()=user_id) with check(auth.uid()=user_id);

-- Verification: every result should be 0.
select count(*) as invalid_memory_batch_ownership from public.memory_processing_batches batch
join public.imported_conversation_segments segment on segment.id=batch.segment_id
where batch.user_id<>segment.user_id or batch.character_id<>segment.character_id or batch.import_id<>segment.import_id;

select count(*) as invalid_experience_ownership from public.memory_experience_candidates candidate
join public.memory_processing_batches batch on batch.id=candidate.batch_id
where candidate.user_id<>batch.user_id or candidate.character_id<>batch.character_id;
