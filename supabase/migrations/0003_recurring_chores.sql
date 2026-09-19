-- Recurring chores + editing scheduled chores.
--
-- A repeating chore is a "series". Every occurrence is a normal chore_instances row
-- linked to its series through parent_recurrence_id (already in the schema), so
-- completing, moving or removing ONE occurrence never touches the others (spec 4.1).
--
-- Occurrences are created lazily: chore_series.generated_through is a cursor, and
-- extend_recurring_chores() only ever moves it forward. That is what lets a repeating
-- chore run indefinitely without filling the calendar up front, and it is why an
-- occurrence you deleted stays deleted.
--
-- Run 0001 and 0002 first.

create table public.chore_series (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  chore_id uuid references public.chore_library(id) on delete set null,
  title text not null,
  points integer not null check (points between 1 and 10),
  assigned_to uuid references public.profiles(id),
  frequency text not null check (frequency in ('daily', 'weekly', 'biweekly', 'monthly')),
  start_date date not null,
  end_date date,
  generated_through date not null,
  created_at timestamptz default now()
);
create index chore_series_household_idx on public.chore_series (household_id);

alter table public.chore_series enable row level security;
create policy series_select on public.chore_series for select to authenticated
  using (household_id = public.current_household_id());
revoke all on public.chore_series from anon, authenticated;
grant select on public.chore_series to authenticated;

-- One occurrence per series per day. Also makes concurrent top-ups from two devices harmless.
create unique index chore_instances_series_date_uniq
  on public.chore_instances (parent_recurrence_id, scheduled_date)
  where parent_recurrence_id is not null;

-- Editing a scheduled chore's points (title, assignee and date were already editable).
grant update (points_assigned) on public.chore_instances to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- n-th occurrence counted from the anchor (not cumulatively), so a monthly chore
-- anchored on Jan 31 lands on Feb 28, then Mar 31 rather than drifting to the 28th.
create function public.series_occurrence(p_start date, p_frequency text, p_n integer)
returns date language sql immutable as $$
  select case p_frequency
    when 'daily' then p_start + p_n
    when 'weekly' then p_start + 7 * p_n
    when 'biweekly' then p_start + 14 * p_n
    when 'monthly' then (p_start + make_interval(months => p_n))::date
  end
$$;

create function public.series_rule(p_frequency text)
returns text language sql immutable as $$
  select case p_frequency
    when 'daily' then 'FREQ=DAILY'
    when 'weekly' then 'FREQ=WEEKLY'
    when 'biweekly' then 'FREQ=WEEKLY;INTERVAL=2'
    when 'monthly' then 'FREQ=MONTHLY'
  end
$$;

-- Bulk-created occurrences must not each ping the partner; callers send one summary instead.
create or replace function public.notify_chore_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor_name text;
begin
  if current_setting('duosync.skip_assign_notify', true) = 'on' then
    return new;
  end if;
  if new.assigned_to is null or new.assigned_to = auth.uid() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;
  select display_name into actor_name from public.profiles where id = auth.uid();
  insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
  values (
    new.assigned_to, auth.uid(), 'chore_assigned', new.id,
    coalesce(actor_name, 'Someone') || ' assigned you: ' || new.title
  );
  return new;
end $$;

-- Internal: creates the missing occurrences of one series up to p_until. Not callable by clients.
create function public.generate_series_instances(p_series_id uuid, p_until date)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.chore_series;
  n integer := 1;
  d date;
  -- one day of slack so a user west of UTC still gets "today"
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
        is_recurring, recurrence_rule, parent_recurrence_id, points_assigned
      ) values (
        s.chore_id, s.title, s.household_id, s.assigned_to, d,
        true, public.series_rule(s.frequency), s.id, s.points
      )
      on conflict do nothing;
    end if;
    n := n + 1;
  end loop;

  update public.chore_series
  set generated_through = greatest(generated_through, p_until)
  where id = s.id;
end $$;
revoke all on function public.generate_series_instances(uuid, date) from public, anon, authenticated;

create function public.make_chore_recurring(p_instance_id uuid, p_frequency text)
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
    household_id, chore_id, title, points, assigned_to, frequency, start_date, generated_through
  ) values (
    hh, inst.chore_id, inst.title, inst.points_assigned, inst.assigned_to, p_frequency,
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

-- "This and future": applies title / points / assignee to this occurrence and every later
-- unfinished one, and can change how often it repeats (p_frequency = 'none' stops the series).
-- Earlier and completed occurrences are history and never change.
create function public.update_chore_series(
  p_instance_id uuid, p_title text, p_points integer, p_assigned_to uuid, p_frequency text
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
  if p_points is null or p_points < 1 or p_points > 10 then raise exception 'Points must be between 1 and 10'; end if;
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
  set title = new_title, points = p_points, assigned_to = p_assigned_to
  where id = s.id;

  update public.chore_instances
  set title = new_title, points_assigned = p_points, assigned_to = p_assigned_to
  where parent_recurrence_id = s.id and not is_completed and scheduled_date >= inst.scheduled_date;

  if p_frequency = 'none' then
    update public.chore_series set end_date = inst.scheduled_date where id = s.id;
    delete from public.chore_instances
    where parent_recurrence_id = s.id and not is_completed and scheduled_date > inst.scheduled_date;
  elsif p_frequency <> s.frequency then
    -- Re-anchor on this occurrence and rebuild everything after it.
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

-- Called as you browse forward: tops every series up to p_until (capped at a year out).
create function public.extend_recurring_chores(p_until date)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  hh uuid := public.current_household_id();
  target date := least(p_until, current_date + 366);
  sid uuid;
begin
  if auth.uid() is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  for sid in
    select id from public.chore_series
    where household_id = hh
      and generated_through < target
      and (end_date is null or end_date > generated_through)
  loop
    perform public.generate_series_instances(sid, target);
  end loop;
end $$;

revoke all on function
  public.make_chore_recurring(uuid, text),
  public.update_chore_series(uuid, text, integer, uuid, text),
  public.extend_recurring_chores(date)
from public, anon;
grant execute on function
  public.make_chore_recurring(uuid, text),
  public.update_chore_series(uuid, text, integer, uuid, text),
  public.extend_recurring_chores(date)
to authenticated;
