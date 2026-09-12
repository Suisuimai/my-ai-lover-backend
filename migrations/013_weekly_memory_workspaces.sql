-- Aggregate segment-level evidence into one import/week workspace.
-- Additive only: existing Timeline, prompt documents, and candidates remain unchanged.

create table if not exists public.memory_import_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  import_id uuid not null references public.conversation_imports(id) on delete cascade,
  status text not null default 'collecting' check (status in ('collecting','review','applied','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id)
);

alter table public.memory_processing_batches add column if not exists workspace_id uuid;
alter table public.memory_knowledge_notes add column if not exists target_document_id uuid references public.prompt_documents(id) on delete set null;

insert into public.memory_import_workspaces (user_id,character_id,import_id)
select distinct user_id,character_id,import_id from public.memory_processing_batches
on conflict (import_id) do nothing;

update public.memory_processing_batches batch
set workspace_id=workspace.id
from public.memory_import_workspaces workspace
where batch.workspace_id is null and workspace.import_id=batch.import_id and workspace.user_id=batch.user_id;

do $$ begin
  alter table public.memory_processing_batches add constraint memory_batches_workspace_fk
    foreign key (workspace_id) references public.memory_import_workspaces(id) on delete cascade;
exception when duplicate_object then null;
end $$;

create table if not exists public.memory_document_patch_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.memory_import_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  document_id uuid not null references public.prompt_documents(id) on delete cascade,
  document_name text not null,
  previous_content text not null,
  proposed_content text not null,
  change_summary text not null,
  merge_reason text not null,
  source_note_ids uuid[] not null default '{}',
  mention_count integer not null,
  segment_count integer not null,
  review_status text not null default 'suggested' check (review_status in ('suggested','confirmed','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (workspace_id,document_id)
);

create index if not exists memory_workspaces_user_status_idx on public.memory_import_workspaces(user_id,status,updated_at desc);
create index if not exists memory_batches_workspace_idx on public.memory_processing_batches(workspace_id);
create index if not exists memory_notes_target_idx on public.memory_knowledge_notes(target_document_id,status);
create index if not exists memory_document_patches_workspace_idx on public.memory_document_patch_candidates(workspace_id,review_status);

alter table public.memory_import_workspaces enable row level security;
alter table public.memory_document_patch_candidates enable row level security;
create policy "Users manage their memory import workspaces" on public.memory_import_workspaces for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "Users manage their weekly document patches" on public.memory_document_patch_candidates for all using(auth.uid()=user_id) with check(auth.uid()=user_id);

-- Verification: every result should be 0.
select count(*) as invalid_workspace_ownership from public.memory_import_workspaces workspace
join public.conversation_imports import on import.id=workspace.import_id
where workspace.user_id<>import.user_id or workspace.character_id<>import.character_id;

select count(*) as invalid_workspace_batch_link from public.memory_processing_batches batch
join public.memory_import_workspaces workspace on workspace.id=batch.workspace_id
where batch.user_id<>workspace.user_id or batch.character_id<>workspace.character_id or batch.import_id<>workspace.import_id;

select count(*) as invalid_note_document_target from public.memory_knowledge_notes note
join public.prompt_documents document on document.id=note.target_document_id
where note.user_id<>document.user_id or note.character_id<>document.character_id;
