-- Same corpus rules, BM25 statistics and scoring as match_source_window_lexical (026).
-- Window validity is computed in one set-based pass instead of a correlated check per
-- window, and only windows sharing a query term (GIN on lexical_terms) are scored; those
-- are exactly the windows that contribute to document frequency. Scores agree with 026
-- to floating-point summation error, so only the order of exactly tied windows can differ.
create or replace function public.match_source_window_lexical(
  p_user_id uuid,p_character_id uuid,p_terms text[],p_limit integer default 80
) returns table(window_id uuid,shared_day_id uuid,source_message_ids uuid[],matched_terms integer,lexical_score double precision,occurred_at timestamptz)
language sql stable security definer set search_path=public as $$
  with owned as materialized (
    select retrieval.id,retrieval.source_message_ids,cardinality(retrieval.lexical_terms) dl
    from public.source_retrieval_windows retrieval
    where retrieval.user_id=p_user_id and retrieval.character_id=p_character_id
      and retrieval.algorithm_version='raw-turn-window-v1'
  ), latest as materialized (
    select operational_message_id,max(revision_number) revision_number
    from public.source_messages where operational_message_id is not null group by operational_message_id
  ), invalid as materialized (
    select distinct owned.id
    from owned cross join lateral unnest(owned.source_message_ids) source_id
    left join public.source_messages source on source.id=source_id
    left join latest on latest.operational_message_id=source.operational_message_id
    where source.id is null or source.user_id<>p_user_id or source.character_id<>p_character_id
      or latest.revision_number>source.revision_number
  ), stats as materialized (
    select count(*)::double precision n,coalesce(avg(owned.dl),1)::double precision avgdl
    from owned where not exists(select 1 from invalid where invalid.id=owned.id)
  ), postings as materialized (
    -- Intermediate CTEs have no indexes, so each step flows forward without joining back.
    select retrieval.id,retrieval.shared_day_id,retrieval.source_message_ids,retrieval.occurred_at,
      cardinality(retrieval.lexical_terms) dl,query_terms.term
    from public.source_retrieval_windows retrieval
    join (select distinct unnest(p_terms) term) query_terms on query_terms.term=any(retrieval.lexical_terms)
    where retrieval.user_id=p_user_id and retrieval.character_id=p_character_id
      and retrieval.algorithm_version='raw-turn-window-v1'
      and retrieval.lexical_terms && p_terms
      and not exists(select 1 from invalid where invalid.id=retrieval.id)
  ), term_stats as materialized (
    select postings.term,count(*)::double precision df from postings group by postings.term
  )
  select postings.id window_id,postings.shared_day_id,postings.source_message_ids,count(*)::integer matched_terms,
    sum(ln(((stats.n-term_stats.df+0.5)/(term_stats.df+0.5))+1) *
      (2.2/(1+1.2*(0.25+0.75*postings.dl/stats.avgdl))))::double precision lexical_score,
    postings.occurred_at
  from postings join term_stats on term_stats.term=postings.term cross join stats
  group by postings.id,postings.shared_day_id,postings.source_message_ids,postings.occurred_at,postings.dl,stats.n,stats.avgdl
  order by lexical_score desc,postings.occurred_at desc limit least(greatest(p_limit,1),200)
$$;

revoke all on function public.match_source_window_lexical(uuid,uuid,text[],integer) from public,anon,authenticated;
grant execute on function public.match_source_window_lexical(uuid,uuid,text[],integer) to service_role;

-- Rollback: re-run the match_source_window_lexical definition from 026_source_retrieval_windows.sql.
