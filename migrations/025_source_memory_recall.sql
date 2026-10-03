-- Source-grounded memory retrieval: immutable lexical/semantic coordinates plus an operational recall pointer.
create extension if not exists vector with schema extensions;

create table if not exists public.source_message_search_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  source_message_id uuid not null references public.source_messages(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  lexical_terms text[] not null check(cardinality(lexical_terms)>0),
  algorithm_version text not null default 'unicode-bigram-v1',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(source_message_id,algorithm_version)
);

create table if not exists public.source_message_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  source_message_id uuid not null references public.source_messages(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  model_id text not null,
  embedding extensions.vector not null,
  dimensions integer not null check(dimensions>0),
  created_at timestamptz not null default now(),
  unique(source_message_id,model_id)
);

create table if not exists public.memory_recall_pointers (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  anchor_source_message_ids uuid[] not null check(cardinality(anchor_source_message_ids)>0),
  pointer_label text not null,
  query_terms text[] not null default '{}',
  active boolean not null default true,
  recalled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists source_search_owner_day_idx on public.source_message_search_documents(user_id,character_id,shared_day_id,occurred_at);
create index if not exists source_search_terms_gin_idx on public.source_message_search_documents using gin(lexical_terms);
create index if not exists source_embeddings_owner_day_idx on public.source_message_embeddings(user_id,character_id,model_id,shared_day_id);

create or replace function public.reject_source_search_document_update()
returns trigger language plpgsql as $$ begin
  raise exception 'source_message_search_documents is append-only; add a new algorithm version instead';
end; $$;
create or replace function public.reject_source_embedding_update()
returns trigger language plpgsql as $$ begin
  raise exception 'source_message_embeddings is append-only; add a new model version instead';
end; $$;
drop trigger if exists source_search_documents_no_update on public.source_message_search_documents;
create trigger source_search_documents_no_update before update on public.source_message_search_documents
for each row execute function public.reject_source_search_document_update();
drop trigger if exists source_embeddings_no_update on public.source_message_embeddings;
create trigger source_embeddings_no_update before update on public.source_message_embeddings
for each row execute function public.reject_source_embedding_update();

create or replace function public.match_source_lexical(
  p_user_id uuid,p_character_id uuid,p_terms text[],p_limit integer default 80
) returns table(source_message_id uuid,shared_day_id uuid,matched_terms integer,lexical_score double precision,occurred_at timestamptz)
language sql stable security definer set search_path=public as $$
  with corpus as (
    select document.* from public.source_message_search_documents document
    join public.source_messages source on source.id=document.source_message_id
    where document.user_id=p_user_id and document.character_id=p_character_id and document.algorithm_version='unicode-bigram-v1'
      and not exists(select 1 from public.source_messages newer where newer.operational_message_id=source.operational_message_id and newer.revision_number>source.revision_number)
  ), stats as (
    select count(*)::double precision n,coalesce(avg(cardinality(lexical_terms)),1)::double precision avgdl from corpus
  ), query_terms as (
    select distinct unnest(p_terms) term
  ), term_stats as (
    select query_terms.term,count(corpus.id)::double precision df from query_terms left join corpus on query_terms.term=any(corpus.lexical_terms) group by query_terms.term
  ), scored as (
    select corpus.source_message_id,corpus.shared_day_id,count(term_stats.term)::integer matched_terms,
      sum(ln(((stats.n-term_stats.df+0.5)/(term_stats.df+0.5))+1) *
        (2.2/(1+1.2*(0.25+0.75*cardinality(corpus.lexical_terms)/stats.avgdl))))::double precision lexical_score,
      corpus.occurred_at
    from corpus cross join stats join term_stats on term_stats.term=any(corpus.lexical_terms)
    group by corpus.source_message_id,corpus.shared_day_id,corpus.occurred_at,stats.n,stats.avgdl
  )
  select * from scored order by lexical_score desc,occurred_at desc limit least(greatest(p_limit,1),200)
$$;

create or replace function public.match_source_semantic(
  p_user_id uuid,p_character_id uuid,p_model_id text,p_query_embedding text,p_limit integer default 80
) returns table(source_message_id uuid,shared_day_id uuid,similarity double precision)
language sql stable security definer set search_path=public,extensions as $$
  select item.source_message_id,item.shared_day_id,
    (1-(item.embedding <=> p_query_embedding::vector))::double precision
  from public.source_message_embeddings item
  join public.source_messages source on source.id=item.source_message_id
  where item.user_id=p_user_id and item.character_id=p_character_id and item.model_id=p_model_id
    and item.dimensions=vector_dims(p_query_embedding::vector)
    and not exists(select 1 from public.source_messages newer where newer.operational_message_id=source.operational_message_id and newer.revision_number>source.revision_number)
  order by item.embedding <=> p_query_embedding::vector limit least(greatest(p_limit,1),200)
$$;

alter table public.source_message_search_documents enable row level security;
alter table public.source_message_embeddings enable row level security;
alter table public.memory_recall_pointers enable row level security;
create policy "Users read their source search coordinates" on public.source_message_search_documents for select using(auth.uid()=user_id);
create policy "Users read their source embeddings" on public.source_message_embeddings for select using(auth.uid()=user_id);
create policy "Users read their recall pointer" on public.memory_recall_pointers for select using(auth.uid()=user_id);

revoke all on function public.match_source_lexical(uuid,uuid,text[],integer) from public,anon,authenticated;
revoke all on function public.match_source_semantic(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.match_source_lexical(uuid,uuid,text[],integer) to service_role;
grant execute on function public.match_source_semantic(uuid,uuid,text,text,integer) to service_role;

-- Verification: every result should be 0.
select count(*) as invalid_source_search_ownership from public.source_message_search_documents document
where not exists(select 1 from public.source_messages source where source.id=document.source_message_id and source.user_id=document.user_id and source.character_id=document.character_id);
select count(*) as invalid_source_embedding_ownership from public.source_message_embeddings item
where not exists(select 1 from public.source_messages source where source.id=item.source_message_id and source.user_id=item.user_id and source.character_id=item.character_id);
select count(*) as invalid_recall_pointer_ownership from public.memory_recall_pointers pointer
where not exists(select 1 from public.sessions session where session.id=pointer.session_id and session.user_id=pointer.user_id and session.character_id=pointer.character_id);

-- Rollback: drop both match functions, the operational pointer table, then the two append-only coordinate tables.
