-- The dynamic ledger: modifying a finished chore re-prices it and adjusts balances by the difference.
--
-- Before: a finished chore's points were frozen. To change them you had to uncheck it first.
-- Now: change the logged time, the chore tax, the split or the assignee of a finished chore and the
-- system recalculates its total, works out each person's difference (new share - old share) and
-- credits or debits their balance straight away. Uncheck and delete keep working because they read
-- the completion row, which is re-priced in the same step.
--
--   * edit_completed_chore()  - now also takes logged minutes, tax and the owner's split
--   * update_library_chore()  - a tax change in Manage chores re-prices finished copies too
--                               (optional: p_reprice_finished => false leaves history alone)
--   * reprice_completion()    - the shared, internal calculation (not callable by clients)
--   * remove_chore_series()   - "delete all" for a repeating chore
--
-- If someone already spent points that are now taken back, their balance stops at 0 (profiles.points
-- has CHECK >= 0), exactly as uncheck does. The reported difference is what really changed.
--
-- Replaces two functions with wider signatures (old calls keep working: the new arguments have
-- defaults) and adds two. Run 0001-0008 first.

-- ---------------------------------------------------------------------------
-- A completion now remembers the owner's split, so it can be re-priced exactly
-- ---------------------------------------------------------------------------
alter table public.chore_completions add column owner_percent integer;

-- Older rows: find the split that reproduces the stored minutes and points; failing that, the
-- nearest to the stored minutes; failing that, 100.
update public.chore_completions c
set owner_percent = coalesce(
  (select p from generate_series(0, 100, 10) p
   where round(c.total_duration_minutes * p / 100.0) = c.user_a_duration
     and round((c.user_a_points + c.user_b_points) * p / 100.0) = c.user_a_points
   order by abs(p * c.total_duration_minutes / 100.0 - c.user_a_duration),
            abs(p - 100.0 * c.user_a_points / nullif(c.user_a_points + c.user_b_points, 0)) nulls last,
            p desc
   limit 1),
  case when c.total_duration_minutes > 0
       then least(100, greatest(0, (round(100.0 * c.user_a_duration / c.total_duration_minutes / 10) * 10)::integer))
  end,
  100
);

alter table public.chore_completions
  alter column owner_percent set default 100,
  alter column owner_percent set not null,
  add constraint chore_completions_owner_percent_check check (owner_percent between 0 and 100 and owner_percent % 10 = 0);

-- New notification type for "your balance changed because something finished was edited".
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'chore_assigned', 'chore_completed',
  'challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed',
  'reward_redeemed', 'points_adjusted'
));

-- complete_chore now stores the split it was given (body otherwise as in 0007).
create or replace function public.complete_chore(
  p_instance_id uuid, p_total_minutes integer, p_my_percent integer default 100
) returns public.chore_completions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  owner uuid;
  other uuid;
  partner uuid;
  caller_name text;
  total_pts integer;
  own_min integer; own_pts integer; oth_min integer; oth_pts integer;
  partner_pts integer;
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

  owner := coalesce(inst.assigned_to, uid);
  if owner = uid then other := partner; else other := uid; end if;
  if other is null then
    if p_my_percent <> 100 then raise exception 'There is no partner to split with yet'; end if;
    other := owner;
  end if;

  total_pts := public.chore_points(p_total_minutes, inst.chore_tax);
  own_min := round(p_total_minutes * p_my_percent / 100.0);
  oth_min := p_total_minutes - own_min;
  own_pts := round(total_pts * p_my_percent / 100.0);
  oth_pts := total_pts - own_pts;

  insert into public.chore_completions (
    instance_id, total_duration_minutes, owner_percent,
    user_a_id, user_a_duration, user_a_points,
    user_b_id, user_b_duration, user_b_points
  ) values (
    inst.id, p_total_minutes, p_my_percent, owner, own_min, own_pts, other, oth_min, oth_pts
  ) returning * into result;

  update public.chore_instances
  set is_completed = true, completed_at = now(), assigned_to = owner
  where id = inst.id;

  update public.profiles set points = points + own_pts where id = owner;
  if other <> owner then
    update public.profiles set points = points + oth_pts where id = other;
  end if;

  if partner is not null then
    partner_pts := case when partner = owner then own_pts else oth_pts end;
    select display_name into caller_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      partner, uid, 'chore_completed', inst.id,
      caller_name || ' completed: ' || inst.title
        || case when owner <> uid then ' for you' else '' end
        || case when partner_pts > 0 then ' (you earned ' || partner_pts || ' pts)' else '' end
    );
  end if;

  return result;
end $$;

-- ---------------------------------------------------------------------------
-- The ledger calculation. Internal: only other SECURITY DEFINER functions call it.
-- Any argument left null keeps the completion's current value. Returns each affected
-- person's REAL balance change (after the floor at 0).
-- ---------------------------------------------------------------------------
create function public.reprice_completion(
  p_instance_id uuid, p_total_minutes integer, p_tax integer, p_owner uuid, p_owner_percent integer
) returns table (o_user uuid, o_delta integer)
language plpgsql security definer set search_path = '' as $$
declare
  comp public.chore_completions;
  inst public.chore_instances;
  pct integer;
  new_min integer;
  new_tax integer;
  new_owner uuid;
  new_other uuid;
  total_pts integer;
  own_min integer; own_pts integer; oth_min integer; oth_pts integer;
  u uuid;
  old_pts integer; new_pts integer;
  bal_before integer; bal_after integer;
begin
  select * into inst from public.chore_instances where id = p_instance_id;
  if not found then raise exception 'Chore not found'; end if;
  select * into comp from public.chore_completions where instance_id = p_instance_id for update;
  if not found then return; end if; -- finished without a completion record: nothing was paid, nothing to adjust

  pct := coalesce(p_owner_percent, comp.owner_percent);
  new_min := coalesce(p_total_minutes, comp.total_duration_minutes);
  new_tax := coalesce(p_tax, inst.chore_tax);
  new_owner := coalesce(p_owner, comp.user_a_id);

  select id into new_other from public.profiles where household_id = inst.household_id and id <> new_owner limit 1;
  if new_other is null then
    if pct <> 100 then raise exception 'There is no partner to split with yet'; end if;
    new_other := new_owner; -- solo household: the other slot mirrors the owner with a zero share
  end if;

  total_pts := public.chore_points(new_min, new_tax);
  own_min := round(new_min * pct / 100.0);
  oth_min := new_min - own_min;
  own_pts := round(total_pts * pct / 100.0);
  oth_pts := total_pts - own_pts;

  for u in
    select distinct t.x from unnest(array[comp.user_a_id, comp.user_b_id, new_owner, new_other]) as t(x) where t.x is not null
  loop
    old_pts := (case when comp.user_a_id = u then comp.user_a_points else 0 end)
             + (case when comp.user_b_id = u then comp.user_b_points else 0 end);
    new_pts := (case when new_owner = u then own_pts else 0 end)
             + (case when new_other = u then oth_pts else 0 end);

    select points into bal_before from public.profiles where id = u;
    if new_pts <> old_pts then
      update public.profiles set points = greatest(points + (new_pts - old_pts), 0) where id = u;
    end if;
    select points into bal_after from public.profiles where id = u;

    o_user := u;
    o_delta := bal_after - bal_before;
    return next;
  end loop;

  update public.chore_completions
  set total_duration_minutes = new_min, owner_percent = pct,
      user_a_id = new_owner, user_a_duration = own_min, user_a_points = own_pts,
      user_b_id = new_other, user_b_duration = oth_min, user_b_points = oth_pts
  where id = comp.id;
end $$;

revoke all on function public.reprice_completion(uuid, integer, integer, uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Edit a finished chore (name, day, assignee and now time, tax and split), re-pricing it.
-- ---------------------------------------------------------------------------
drop function public.edit_completed_chore(uuid, text, uuid, date);

create function public.edit_completed_chore(
  p_instance_id uuid, p_title text, p_assigned_to uuid, p_scheduled_date date,
  p_total_minutes integer default null, p_tax integer default null, p_owner_percent integer default null
) returns table (o_user uuid, o_delta integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  comp public.chore_completions;
  has_comp boolean;
  new_title text := trim(coalesce(p_title, ''));
  new_owner uuid;
  changed boolean;
  caller_name text;
  r record;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if p_scheduled_date is null then raise exception 'Choose a day'; end if;
  if p_assigned_to is not null and not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;
  if p_total_minutes is not null
     and (p_total_minutes < 5 or p_total_minutes > 1440 or p_total_minutes % 5 <> 0) then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is not null and (p_tax < 0 or p_tax > 50) then raise exception 'Chore tax must be between 0 and 50'; end if;
  if p_owner_percent is not null and (p_owner_percent < 0 or p_owner_percent > 100 or p_owner_percent % 10 <> 0) then
    raise exception 'Split must be a multiple of 10 between 0 and 100';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if not inst.is_completed then raise exception 'Use the normal edit for a chore that is not completed yet'; end if;
  -- Someone earned these points, so a finished chore always has an owner.
  if p_assigned_to is null and inst.assigned_to is not null then
    raise exception 'A finished chore has to stay assigned to someone';
  end if;

  select * into comp from public.chore_completions where instance_id = inst.id;
  has_comp := found;

  -- Only a real change of assignee moves the credit (older completions may pre-date "points to the assignee").
  new_owner := case when p_assigned_to is distinct from inst.assigned_to then p_assigned_to end;
  changed := has_comp and (
    (p_total_minutes is not null and p_total_minutes is distinct from comp.total_duration_minutes)
    or (p_tax is not null and p_tax is distinct from inst.chore_tax)
    or new_owner is not null
    or (p_owner_percent is not null and p_owner_percent is distinct from comp.owner_percent)
  );

  -- Correcting a finished chore must not ping the partner as if it were a new assignment.
  perform set_config('duosync.skip_assign_notify', 'on', true);

  update public.chore_instances
  set title = new_title, assigned_to = coalesce(p_assigned_to, assigned_to), scheduled_date = p_scheduled_date,
      chore_tax = coalesce(p_tax, chore_tax)
  where id = inst.id;

  if changed then
    select display_name into caller_name from public.profiles where id = uid;
    for r in select * from public.reprice_completion(inst.id, p_total_minutes, p_tax, new_owner, p_owner_percent) loop
      if r.o_user <> uid and r.o_delta <> 0 then
        insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
        values (
          r.o_user, uid, 'points_adjusted', inst.id,
          caller_name || ' updated ' || new_title || ': your balance '
            || case when r.o_delta > 0 then 'went up by ' else 'went down by ' end || abs(r.o_delta) || ' pts'
        );
      end if;
      o_user := r.o_user;
      o_delta := r.o_delta;
      return next;
    end loop;
  end if;
end $$;

revoke all on function public.edit_completed_chore(uuid, text, uuid, date, integer, integer, integer) from public, anon;
grant execute on function public.edit_completed_chore(uuid, text, uuid, date, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Manage chores: a tax change now re-prices the finished copies too (unless told not to).
-- Same behaviour as 0008 otherwise; the result gains n_done, my_delta and their_delta.
-- ---------------------------------------------------------------------------
drop function public.update_library_chore(uuid, text, text, integer, integer);

create function public.update_library_chore(
  p_chore_id uuid, p_title text, p_category text, p_duration integer, p_tax integer,
  p_reprice_finished boolean default true
) returns table (n_open integer, n_series integer, n_done integer, my_delta integer, their_delta integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  lib public.chore_library;
  new_title text := trim(coalesce(p_title, ''));
  new_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'General');
  title_changed boolean;
  time_changed boolean;
  tax_changed boolean;
  reprice boolean;
  c record;
  r record;
  partner uuid;
  caller_name text;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if char_length(new_title) > 60 then raise exception 'Keep the name to 60 characters or fewer'; end if;
  if char_length(new_category) > 30 then raise exception 'Keep the category to 30 characters or fewer'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;

  select * into lib from public.chore_library
  where id = p_chore_id and household_id = hh and not coalesce(is_archived, false)
  for update;
  if not found then raise exception 'Chore not found'; end if;

  if exists (
    select 1 from public.chore_library
    where household_id = hh and id <> lib.id and not coalesce(is_archived, false)
      and lower(title) = lower(new_title)
  ) then
    raise exception 'You already have a chore called "%"', new_title;
  end if;

  title_changed := new_title is distinct from lib.title;
  time_changed := p_duration is distinct from lib.default_duration;
  tax_changed := p_tax is distinct from lib.chore_tax;
  reprice := tax_changed and coalesce(p_reprice_finished, true);

  update public.chore_library
  set title = new_title, category = new_category, default_duration = p_duration, chore_tax = p_tax
  where id = lib.id;

  n_open := 0; n_series := 0; n_done := 0; my_delta := 0; their_delta := 0;
  if not (title_changed or time_changed or tax_changed) then
    return next;
    return;
  end if;

  -- Unfinished copies: whatever changed follows the library.
  update public.chore_instances
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then p_tax else chore_tax end
  where chore_id = lib.id and household_id = hh and not is_completed;
  get diagnostics n_open = row_count;

  -- Finished copies: the name always follows. The estimate follows too (it does not affect points, which
  -- come from the time actually logged). A tax change re-prices them and adjusts balances.
  for c in
    select id from public.chore_instances where chore_id = lib.id and household_id = hh and is_completed
  loop
    update public.chore_instances
    set title = case when title_changed then new_title else title end,
        estimated_duration = case when time_changed then p_duration else estimated_duration end,
        chore_tax = case when reprice then p_tax else chore_tax end
    where id = c.id;

    if reprice then
      n_done := n_done + 1;
      for r in select * from public.reprice_completion(c.id, null, p_tax, null, null) loop
        if r.o_user = uid then my_delta := my_delta + r.o_delta; else their_delta := their_delta + r.o_delta; end if;
      end loop;
    end if;
  end loop;

  -- Repeating series, so the days generated from now on carry the new values too.
  update public.chore_series
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then p_tax else chore_tax end
  where chore_id = lib.id and household_id = hh and (end_date is null or end_date >= current_date);
  get diagnostics n_series = row_count;

  -- One summary for the partner, not one per finished chore.
  if their_delta <> 0 then
    select id into partner from public.profiles where household_id = hh and id <> uid limit 1;
    select display_name into caller_name from public.profiles where id = uid;
    if partner is not null then
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (
        partner, uid, 'points_adjusted', lib.id,
        caller_name || ' changed the chore tax on ' || new_title || ': your balance '
          || case when their_delta > 0 then 'went up by ' else 'went down by ' end || abs(their_delta)
          || ' pts across ' || n_done || case when n_done = 1 then ' finished chore' else ' finished chores' end
      );
    end if;
  end if;

  return next;
end $$;

revoke all on function public.update_library_chore(uuid, text, text, integer, integer, boolean) from public, anon;
grant execute on function public.update_library_chore(uuid, text, text, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- "Delete all": remove every unfinished day of a repeating chore and stop it repeating.
-- Finished days are history and stay. Returns how many days were removed.
-- ---------------------------------------------------------------------------
create function public.remove_chore_series(p_instance_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  s public.chore_series;
  removed integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if inst.is_completed then raise exception 'A finished chore is deleted on its own'; end if;
  if inst.parent_recurrence_id is null then raise exception 'That chore does not repeat'; end if;

  select * into s from public.chore_series where id = inst.parent_recurrence_id and household_id = hh for update;
  if not found then raise exception 'That repeating chore no longer exists'; end if;

  -- Stop the series at the last day already generated so nothing new appears.
  update public.chore_series
  set end_date = least(coalesce(end_date, generated_through), generated_through)
  where id = s.id;

  delete from public.notifications
  where type = 'chore_assigned'
    and reference_id in (
      select id from public.chore_instances where parent_recurrence_id = s.id and not is_completed
    );

  delete from public.chore_instances
  where parent_recurrence_id = s.id and household_id = hh and not is_completed;
  get diagnostics removed = row_count;

  return removed;
end $$;

revoke all on function public.remove_chore_series(uuid) from public, anon;
grant execute on function public.remove_chore_series(uuid) to authenticated;
