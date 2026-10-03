-- Retrieval v2: index overlapping windows of exact source messages without creating summaries.
create table if not exists public.source_retrieval_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  shared_day_id uuid not null references public.shared_life_days(id) on delete cascade,
  window_key text not null,
  source_message_ids uuid[] not null check(cardinality(source_message_ids)>0),
  lexical_terms text[] not null check(cardinality(lexical_terms)>0),
  algorithm_version text not null default 'raw-turn-window-v1',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(user_id,character_id,window_key,algorithm_version)
);

create table if not exists public.source_retrieval_window_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  window_id uuid not null references public.source_retrieval_windows(id) on delete cascade,
  model_id text not null,
  embedding extensions.vector not null,
  dimensions integer not null check(dimensions>0),
  created_at timestamptz not null default now(),
  unique(window_id,model_id)
);

create index if not exists source_retrieval_windows_owner_day_idx
  on public.source_retrieval_windows(user_id,character_id,shared_day_id,occurred_at);
create index if not exists source_retrieval_windows_terms_gin_idx
  on public.source_retrieval_windows using gin(lexical_terms);
create index if not exists source_retrieval_window_embeddings_owner_idx
  on public.source_retrieval_window_embeddings(user_id,character_id,model_id,window_id);

create or replace function public.reject_source_retrieval_window_update()
returns trigger language plpgsql as $$ begin
  raise exception 'source_retrieval_windows is append-only; add a new algorithm version instead';
end; $$;
create or replace function public.reject_source_retrieval_window_embedding_update()
returns trigger language plpgsql as $$ begin
  raise exception 'source_retrieval_window_embeddings is append-only; add a new model version instead';
end; $$;
drop trigger if exists source_retrieval_windows_no_update on public.source_retrieval_windows;
create trigger source_retrieval_windows_no_update before update on public.source_retrieval_windows
for each row execute function public.reject_source_retrieval_window_update();
drop trigger if exists source_retrieval_window_embeddings_no_update on public.source_retrieval_window_embeddings;
create trigger source_retrieval_window_embeddings_no_update before update on public.source_retrieval_window_embeddings
for each row execute function public.reject_source_retrieval_window_embedding_update();

create or replace function public.match_source_window_lexical(
  p_user_id uuid,p_character_id uuid,p_terms text[],p_limit integer default 80
) returns table(window_id uuid,shared_day_id uuid,source_message_ids uuid[],matched_terms integer,lexical_score double precision,occurred_at timestamptz)
language sql stable security definer set search_path=public as $$
  with corpus as (
    select retrieval.* from public.source_retrieval_windows retrieval
    where retrieval.user_id=p_user_id and retrieval.character_id=p_character_id
      and retrieval.algorithm_version='raw-turn-window-v1'
      and not exists (
        select 1 from unnest(retrieval.source_message_ids) source_id
        left join public.source_messages source on source.id=source_id
        where source.id is null or source.user_id<>p_user_id or source.character_id<>p_character_id
          or exists(select 1 from public.source_messages newer where newer.operational_message_id=source.operational_message_id and newer.revision_number>source.revision_number)
      )
  ), stats as (
    select count(*)::double precision n,coalesce(avg(cardinality(lexical_terms)),1)::double precision avgdl from corpus
  ), query_terms as (
    select distinct unnest(p_terms) term
  ), term_stats as (
    select query_terms.term,count(corpus.id)::double precision df
    from query_terms left join corpus on query_terms.term=any(corpus.lexical_terms) group by query_terms.term
  ), scored as (
    select corpus.id window_id,corpus.shared_day_id,corpus.source_message_ids,count(term_stats.term)::integer matched_terms,
      sum(ln(((stats.n-term_stats.df+0.5)/(term_stats.df+0.5))+1) *
        (2.2/(1+1.2*(0.25+0.75*cardinality(corpus.lexical_terms)/stats.avgdl))))::double precision lexical_score,
      corpus.occurred_at
    from corpus cross join stats join term_stats on term_stats.term=any(corpus.lexical_terms)
    group by corpus.id,corpus.shared_day_id,corpus.source_message_ids,corpus.occurred_at,stats.n,stats.avgdl
  )
  select * from scored order by lexical_score desc,occurred_at desc limit least(greatest(p_limit,1),200)
$$;

create or replace function public.match_source_window_semantic(
  p_user_id uuid,p_character_id uuid,p_model_id text,p_query_embedding text,p_limit integer default 80
) returns table(window_id uuid,shared_day_id uuid,source_message_ids uuid[],similarity double precision)
language sql stable security definer set search_path=public,extensions as $$
  select retrieval.id,retrieval.shared_day_id,retrieval.source_message_ids,
    (1-(item.embedding <=> p_query_embedding::vector))::double precision
  from public.source_retrieval_window_embeddings item
  join public.source_retrieval_windows retrieval on retrieval.id=item.window_id
  where item.user_id=p_user_id and item.character_id=p_character_id and item.model_id=p_model_id
    and retrieval.algorithm_version='raw-turn-window-v1'
    and item.dimensions=vector_dims(p_query_embedding::vector)
    and not exists (
      select 1 from unnest(retrieval.source_message_ids) source_id
      left join public.source_messages source on source.id=source_id
      where source.id is null or source.user_id<>p_user_id or source.character_id<>p_character_id
        or exists(select 1 from public.source_messages newer where newer.operational_message_id=source.operational_message_id and newer.revision_number>source.revision_number)
    )
  order by item.embedding <=> p_query_embedding::vector limit least(greatest(p_limit,1),200)
$$;

alter table public.source_retrieval_windows enable row level security;
alter table public.source_retrieval_window_embeddings enable row level security;
create policy "Users read their source retrieval windows" on public.source_retrieval_windows
  for select using(auth.uid()=user_id);
create policy "Users read their source retrieval window embeddings" on public.source_retrieval_window_embeddings
  for select using(auth.uid()=user_id);

revoke all on function public.match_source_window_lexical(uuid,uuid,text[],integer) from public,anon,authenticated;
revoke all on function public.match_source_window_semantic(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.match_source_window_lexical(uuid,uuid,text[],integer) to service_role;
grant execute on function public.match_source_window_semantic(uuid,uuid,text,text,integer) to service_role;

-- Verification: every result should be 0.
select count(*) as invalid_retrieval_window_ownership from public.source_retrieval_windows retrieval
where exists (
  select 1 from unnest(retrieval.source_message_ids) source_id
  left join public.source_messages source on source.id=source_id
  where source.id is null or source.user_id<>retrieval.user_id or source.character_id<>retrieval.character_id
);
select count(*) as invalid_retrieval_embedding_ownership from public.source_retrieval_window_embeddings item
where not exists (
  select 1 from public.source_retrieval_windows retrieval
  where retrieval.id=item.window_id and retrieval.user_id=item.user_id and retrieval.character_id=item.character_id
);

-- Rollback: drop both match functions, then the embedding and retrieval-window tables.
