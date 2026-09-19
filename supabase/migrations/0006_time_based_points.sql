-- Time-based points, chore tax, and the unassigned chore pool.
--
--   base points  = round(minutes / 5)        (12 points per hour, minimum 5 minutes)
--   total points = base points + chore_tax   (tax is a flat "unpleasantness" bonus)
--   split        = A gets round(total * share), B gets total - A   (the two always sum exactly)
--
-- An instance with assigned_to = NULL is the "unassigned pool": anyone can claim or complete it.
--
-- Notes
--   * chore_instances.assigned_to was already nullable, so that part of the spec needs no change.
--   * chore_instances.points_assigned and chore_library.default_points are LEGACY. Nothing reads
--     them any more; points now come from time + tax. They are left in place (no data loss).
--   * chore_tax is capped at 50 so a typo cannot mint thousands of points.
--   * update_chore_series() changes signature (points -> duration + tax).
--
-- Run 0001-0005 first.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.chore_library
  add column if not exists chore_tax integer not null default 0 check (chore_tax between 0 and 50);

alter table public.chore_instances alter column assigned_to drop not null;

alter table public.chore_instances
  add column if not exists estimated_duration integer not null default 15
    check (estimated_duration between 5 and 1440 and estimated_duration % 5 = 0),
  add column if not exists chore_tax integer not null default 0 check (chore_tax between 0 and 50);

-- Existing scheduled chores take their estimate from their library chore.
update public.chore_instances i
set estimated_duration = l.default_duration
from public.chore_library l
where i.chore_id = l.id
  and l.default_duration between 5 and 1440
  and l.default_duration % 5 = 0;

alter table public.chore_series
  add column if not exists estimated_duration integer not null default 15
    check (estimated_duration between 5 and 1440 and estimated_duration % 5 = 0),
  add column if not exists chore_tax integer not null default 0 check (chore_tax between 0 and 50);
alter table public.chore_series alter column points drop not null; -- legacy

update public.chore_series s
set estimated_duration = i.estimated_duration, chore_tax = i.chore_tax
from (
  select distinct on (parent_recurrence_id) parent_recurrence_id, estimated_duration, chore_tax
  from public.chore_instances
  where parent_recurrence_id is not null
  order by parent_recurrence_id, scheduled_date desc
) i
where i.parent_recurrence_id = s.id;

grant insert (estimated_duration, chore_tax) on public.chore_instances to authenticated;
grant update (estimated_duration, chore_tax) on public.chore_instances to authenticated;
grant insert (chore_tax) on public.chore_library to authenticated;
grant update (chore_tax) on public.chore_library to authenticated;

-- ---------------------------------------------------------------------------
-- Points helper: the single definition of the formula (mirrored in lib/logic/points.ts)
-- ---------------------------------------------------------------------------

create function public.chore_points(p_minutes integer, p_tax integer)
returns integer language sql immutable as $$
  select round(p_minutes / 5.0)::integer + coalesce(p_tax, 0)
$$;

-- ---------------------------------------------------------------------------
-- Completion: points come from the logged time + the chore's tax.
-- Completing an unassigned chore claims it for the person completing it.
-- ---------------------------------------------------------------------------

create or replace function public.complete_chore(
  p_instance_id uuid, p_total_minutes integer, p_my_percent integer default 100
) returns public.chore_completions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  partner uuid;
  my_name text;
  total_pts integer;
  my_min integer; my_pts integer; pt_min integer; pt_pts integer;
  result public.chore_completions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_total_minutes is null or p_total_minutes < 5 or p_total_minutes > 1440 or p_total_minutes % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_my_percent is null or p_my_percent < 0 or p_my_percent > 100 or p_my_percent % 10 <> 0 then
    raise exception 'Split must be a multiple of 10 between 0 and 100';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if inst.is_completed then raise exception 'That chore is already completed'; end if;

  select id into partner from public.profiles where household_id = hh and id <> uid limit 1;
  if partner is null then
    if p_my_percent <> 100 then raise exception 'There is no partner to split with yet'; end if;
    partner := uid; -- solo household: partner slot mirrors the caller with a zero share
  end if;

  total_pts := public.chore_points(p_total_minutes, inst.chore_tax);
  my_min := round(p_total_minutes * p_my_percent / 100.0);
  pt_min := p_total_minutes - my_min;
  my_pts := round(total_pts * p_my_percent / 100.0);
  pt_pts := total_pts - my_pts;

  insert into public.chore_completions (
    instance_id, total_duration_minutes,
    user_a_id, user_a_duration, user_a_points,
    user_b_id, user_b_duration, user_b_points
  ) values (
    inst.id, p_total_minutes, uid, my_min, my_pts, partner, pt_min, pt_pts
  ) returning * into result;

  update public.chore_instances
  set is_completed = true, completed_at = now(), assigned_to = coalesce(assigned_to, uid)
  where id = inst.id;

  update public.profiles set points = points + my_pts where id = uid;

  if partner <> uid then
    update public.profiles set points = points + pt_pts where id = partner;
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      partner, uid, 'chore_completed', inst.id,
      my_name || ' completed: ' || inst.title
        || case when pt_pts > 0 then ' (you earned ' || pt_pts || ' pts)' else '' end
    );
  end if;

  return result;
end $$;

-- ---------------------------------------------------------------------------
-- Repeating chores carry duration + tax instead of fixed points
-- ---------------------------------------------------------------------------

create or replace function public.generate_series_instances(p_series_id uuid, p_until date)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.chore_series;
  n integer := 1;
  d date;
  earliest date := current_date - 1;
begin
  select * into s from public.chore_series where id = p_series_id for update;
  if not found then return; end if;

  perform set_config('duosync.skip_assign_notify', 'on', true);
  loop
    d := public.series_occurrence(s.start_date, s.frequency, n);
    exit when d > p_until or (s.end_date is not null and d > s.end_date) or n > 4000;
    if d > s.generated_through and d >= earliest then
      insert into public.chore_instances (
        chore_id, title, household_id, assigned_to, scheduled_date,
        is_recurring, recurrence_rule, parent_recurrence_id, estimated_duration, chore_tax
      ) values (
        s.chore_id, s.title, s.household_id, s.assigned_to, d,
        true, public.series_rule(s.frequency), s.id, s.estimated_duration, s.chore_tax
      )
      on conflict do nothing;
    end if;
    n := n + 1;
  end loop;

  update public.chore_series
  set generated_through = greatest(generated_through, p_until)
  where id = s.id;
end $$;

create or replace function public.make_chore_recurring(p_instance_id uuid, p_frequency text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  new_series uuid;
  my_name text;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_frequency is null or p_frequency not in ('daily', 'weekly', 'biweekly', 'monthly') then
    raise exception 'Choose how often it repeats';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if inst.is_completed then raise exception 'A completed chore cannot be made to repeat'; end if;
  if inst.parent_recurrence_id is not null then raise exception 'That chore already repeats'; end if;

  insert into public.chore_series (
    household_id, chore_id, title, estimated_duration, chore_tax, assigned_to, frequency, start_date, generated_through
  ) values (
    hh, inst.chore_id, inst.title, inst.estimated_duration, inst.chore_tax, inst.assigned_to, p_frequency,
    inst.scheduled_date, inst.scheduled_date
  ) returning id into new_series;

  update public.chore_instances
  set is_recurring = true, recurrence_rule = public.series_rule(p_frequency), parent_recurrence_id = new_series
  where id = inst.id;

  perform public.generate_series_instances(new_series, greatest(inst.scheduled_date, current_date) + 84);

  if inst.assigned_to is not null and inst.assigned_to <> uid then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      inst.assigned_to, uid, 'chore_assigned', inst.id,
      my_name || ' set "' || inst.title || '" to repeat '
        || case p_frequency when 'daily' then 'every day' when 'weekly' then 'every week'
             when 'biweekly' then 'every 2 weeks' else 'every month' end
        || ' for you'
    );
  end if;
end $$;

drop function public.update_chore_series(uuid, text, integer, uuid, text);

-- "This and future": title / duration / tax / assignee for this occurrence and every later
-- unfinished one; can also change how often it repeats ('none' stops the series).
create function public.update_chore_series(
  p_instance_id uuid, p_title text, p_duration integer, p_tax integer, p_assigned_to uuid, p_frequency text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  s public.chore_series;
  my_name text;
  new_title text := trim(p_title);
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if coalesce(new_title, '') = '' then raise exception 'Give the chore a name'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;
  if p_assigned_to is not null and not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;
  if p_frequency is null or p_frequency not in ('none', 'daily', 'weekly', 'biweekly', 'monthly') then
    raise exception 'Choose how often it repeats';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if inst.parent_recurrence_id is null then raise exception 'That chore does not repeat'; end if;

  select * into s from public.chore_series where id = inst.parent_recurrence_id for update;
  if not found then raise exception 'That repeating chore no longer exists'; end if;

  perform set_config('duosync.skip_assign_notify', 'on', true);

  update public.chore_series
  set title = new_title, estimated_duration = p_duration, chore_tax = p_tax, assigned_to = p_assigned_to
  where id = s.id;

  update public.chore_instances
  set title = new_title, estimated_duration = p_duration, chore_tax = p_tax, assigned_to = p_assigned_to
  where parent_recurrence_id = s.id and not is_completed and scheduled_date >= inst.scheduled_date;

  if p_frequency = 'none' then
    update public.chore_series set end_date = inst.scheduled_date where id = s.id;
    delete from public.chore_instances
    where parent_recurrence_id = s.id and not is_completed and scheduled_date > inst.scheduled_date;
  elsif p_frequency <> s.frequency then
    delete from public.chore_instances
    where parent_recurrence_id = s.id and not is_completed and scheduled_date > inst.scheduled_date;
    update public.chore_series
    set frequency = p_frequency, start_date = inst.scheduled_date,
        generated_through = inst.scheduled_date, end_date = null
    where id = s.id;
    update public.chore_instances
    set recurrence_rule = public.series_rule(p_frequency)
    where parent_recurrence_id = s.id and not is_completed and scheduled_date >= inst.scheduled_date;
    perform public.generate_series_instances(s.id, greatest(inst.scheduled_date, current_date) + 84);
  end if;

  if p_assigned_to is not null and p_assigned_to <> uid and p_assigned_to is distinct from s.assigned_to then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (p_assigned_to, uid, 'chore_assigned', inst.id, my_name || ' assigned you the repeating chore: ' || new_title);
  end if;
end $$;

revoke all on function public.update_chore_series(uuid, text, integer, integer, uuid, text) from public, anon;
grant execute on function public.update_chore_series(uuid, text, integer, integer, uuid, text) to authenticated;
