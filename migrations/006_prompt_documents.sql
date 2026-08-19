-- V3.4: ordered Markdown prompt documents for each companion.
-- Back up public.prompt_documents if it already exists before applying this migration.

create table if not exists public.prompt_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  content text not null default '' check (char_length(content) <= 30000),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prompt_documents_character_order_idx
  on public.prompt_documents(user_id, character_id, sort_order, created_at);

alter table public.prompt_documents enable row level security;

drop policy if exists "Users manage their own prompt documents" on public.prompt_documents;
create policy "Users manage their own prompt documents"
  on public.prompt_documents
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.characters
      where characters.id = prompt_documents.character_id
        and characters.user_id = auth.uid()
    )
  );

-- Verification: should return 0.
select count(*) as prompt_documents_with_wrong_owner
from public.prompt_documents document
join public.characters character on character.id = document.character_id
where document.user_id <> character.user_id;

-- Rollback note: drop table public.prompt_documents;
