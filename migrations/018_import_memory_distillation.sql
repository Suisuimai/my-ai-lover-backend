-- Let one full imported conversation turn verified experiences into reviewable MD material.
-- Existing Timeline data and existing knowledge notes are left unchanged.

alter table public.memory_knowledge_notes
  add column if not exists source_kind text not null default 'segment_extraction'
  check (source_kind in ('segment_extraction','import_distillation'));

alter table public.memory_knowledge_notes
  add column if not exists source_experience_ids uuid[] not null default '{}';

create index if not exists memory_notes_source_kind_idx
  on public.memory_knowledge_notes(user_id,source_kind,status);

-- Verification: the result should be 0.
select count(*) as invalid_distilled_note_source
from public.memory_knowledge_notes note
where note.source_kind='import_distillation'
  and coalesce(array_length(note.source_experience_ids,1),0)=0;

-- Rollback (only before this feature has stored import_distillation rows):
-- drop index if exists public.memory_notes_source_kind_idx;
-- alter table public.memory_knowledge_notes drop column if exists source_experience_ids;
-- alter table public.memory_knowledge_notes drop column if exists source_kind;
