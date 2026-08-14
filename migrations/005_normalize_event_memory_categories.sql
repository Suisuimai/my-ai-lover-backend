-- V3.3: unfinished is a lifecycle state, not a memory content category.
-- Only linked follow-up event memories are normalized; unrelated legacy rows stay untouched.

update public.memories
set category = 'important_event',
    updated_at = now()
where category = 'unfinished'
  and source_follow_up_id is not null;

select count(*) as linked_unfinished_memories_remaining
from public.memories
where category = 'unfinished'
  and source_follow_up_id is not null;
