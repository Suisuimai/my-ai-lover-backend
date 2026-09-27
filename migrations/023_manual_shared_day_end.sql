-- Allow the user to explicitly end a shared life day without waiting for the next morning.
alter table public.shared_life_day_versions
  drop constraint if exists shared_life_day_versions_boundary_reason_check;
alter table public.shared_life_day_versions
  add constraint shared_life_day_versions_boundary_reason_check check (
    boundary_reason in ('awaiting_end','night_marker','next_shared_day','manual_end')
  );

-- Verification: should be 0.
select count(*) as invalid_manual_shared_day_reason
from public.shared_life_day_versions
where boundary_reason not in ('awaiting_end','night_marker','next_shared_day','manual_end');
