-- Fixed-bounty ("mission") chores.
--
-- A chore is priced one of two ways:
--   time_based    points = round(minutes / 5) + chore tax           (as before)
--   fixed_bounty  points = fixed_bounty_points, whatever the time   (video editing, deep de-cluttering ...)
--
-- For a fixed bounty the logged minutes are still recorded, purely for the hours in Stats. The split slider
-- applies to the bounty exactly as it does to time-based points: the owner gets round(bounty * share) and the
-- other person the remainder, and the minutes split along the same ratio.
--
-- The spec put the two columns on the library and on scheduled chores; they are also needed on repeating
-- chores (chore_series), otherwise every generated day would silently fall back to time-based.
--
-- Also moves chore completion / re-pricing onto the point ledger (0011) as those functions are rewritten.
-- Replaces functions with wider signatures (the new arguments have defaults, so older calls keep working).
-- Run 0001-0011 first.

create type public.chore_pricing_type as enum ('time_based', 'fixed_bounty');

alter table public.chore_library
  add column pricing_type public.chore_pricing_type not null default 'time_based',
  add column fixed_bounty_points integer not null default 15 check (fixed_bounty_points between 1 and 500);

alter table public.chore_instances
  add column pricing_type public.chore_pricing_type not null default 'time_based',
  add column fixed_bounty_points integer not null default 15 check (fixed_bounty_points between 1 and 500);

alter table public.chore_series
  add column pricing_type public.chore_pricing_type not null default 'time_based',
  add column fixed_bounty_points integer not null default 15 check (fixed_bounty_points between 1 and 500);

-- The client creates and edits library / scheduled rows directly, so it needs these columns.
grant insert (pricing_type, fixed_bounty_points) on public.chore_library to authenticated;
grant update (pricing_type, fixed_bounty_points) on public.chore_library to authenticated;
grant insert (pricing_type, fixed_bounty_points) on public.chore_instances to authenticated;
grant update (pricing_type, fixed_bounty_points) on public.chore_instances to authenticated;

-- The single definition of "what is this chore worth" (mirrored in lib/logic/points.ts).
create function public.chore_total_points(
  p_pricing public.chore_pricing_type, p_minutes integer, p_tax integer, p_bounty integer
) returns integer language sql immutable as $$
  select case when p_pricing = 'fixed_bounty' then p_bounty else public.chore_points(p_minutes, p_tax) end
$$;

-- ---------------------------------------------------------------------------
-- Completion (body as 0009, priced by chore_total_points, balances through the ledger)
-- ---------------------------------------------------------------------------
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

  total_pts := public.chore_total_points(inst.pricing_type, p_total_minutes, inst.chore_tax, inst.fixed_bounty_points);
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

  perform public.apply_points(owner, own_pts, 'Chore completed: ' || inst.title, result.id);
  if other <> owner then
    perform public.apply_points(other, oth_pts, 'Chore completed: ' || inst.title, result.id);
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
-- The ledger calculation (0009), now aware of fixed bounties and writing to the point ledger.
-- Any argument left null keeps the completion's / chore's current value.
-- ---------------------------------------------------------------------------
drop function public.reprice_completion(uuid, integer, integer, uuid, integer);

create function public.reprice_completion(
  p_instance_id uuid, p_total_minutes integer, p_tax integer, p_owner uuid, p_owner_percent integer,
  p_bounty integer default null
) returns table (o_user uuid, o_delta integer)
language plpgsql security definer set search_path = '' as $$
declare
  comp public.chore_completions;
  inst public.chore_instances;
  pct integer;
  new_min integer;
  new_owner uuid;
  new_other uuid;
  total_pts integer;
  own_min integer; own_pts integer; oth_min integer; oth_pts integer;
  u uuid;
  old_pts integer; new_pts integer;
begin
  select * into inst from public.chore_instances where id = p_instance_id;
  if not found then raise exception 'Chore not found'; end if;
  select * into comp from public.chore_completions where instance_id = p_instance_id for update;
  if not found then return; end if; -- finished without a completion record: nothing was paid, nothing to adjust

  pct := coalesce(p_owner_percent, comp.owner_percent);
  new_min := coalesce(p_total_minutes, comp.total_duration_minutes);
  new_owner := coalesce(p_owner, comp.user_a_id);

  select id into new_other from public.profiles where household_id = inst.household_id and id <> new_owner limit 1;
  if new_other is null then
    if pct <> 100 then raise exception 'There is no partner to split with yet'; end if;
    new_other := new_owner; -- solo household: the other slot mirrors the owner with a zero share
  end if;

  total_pts := public.chore_total_points(
    inst.pricing_type, new_min, coalesce(p_tax, inst.chore_tax), coalesce(p_bounty, inst.fixed_bounty_points)
  );
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

    o_user := u;
    o_delta := 0;
    if new_pts <> old_pts then
      o_delta := public.apply_points(u, new_pts - old_pts, 'Chore edited: ' || inst.title, comp.id);
    end if;
    return next;
  end loop;

  update public.chore_completions
  set total_duration_minutes = new_min, owner_percent = pct,
      user_a_id = new_owner, user_a_duration = own_min, user_a_points = own_pts,
      user_b_id = new_other, user_b_duration = oth_min, user_b_points = oth_pts
  where id = comp.id;
end $$;

revoke all on function public.reprice_completion(uuid, integer, integer, uuid, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Edit a finished chore (0009 + bounty). The tax only counts for time-based chores and the bounty only for
-- fixed ones, whatever the client sends, so a stray value can never re-price a chore the wrong way.
-- ---------------------------------------------------------------------------
drop function public.edit_completed_chore(uuid, text, uuid, date, integer, integer, integer);

create function public.edit_completed_chore(
  p_instance_id uuid, p_title text, p_assigned_to uuid, p_scheduled_date date,
  p_total_minutes integer default null, p_tax integer default null, p_owner_percent integer default null,
  p_bounty integer default null
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
  tax_arg integer;
  bounty_arg integer;
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
  if p_bounty is not null and (p_bounty < 1 or p_bounty > 500) then raise exception 'Bounty must be between 1 and 500 points'; end if;
  if p_owner_percent is not null and (p_owner_percent < 0 or p_owner_percent > 100 or p_owner_percent % 10 <> 0) then
    raise exception 'Split must be a multiple of 10 between 0 and 100';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if not inst.is_completed then raise exception 'Use the normal edit for a chore that is not completed yet'; end if;
  if p_assigned_to is null and inst.assigned_to is not null then
    raise exception 'A finished chore has to stay assigned to someone';
  end if;

  select * into comp from public.chore_completions where instance_id = inst.id;
  has_comp := found;

  tax_arg := case when inst.pricing_type = 'time_based' then p_tax end;
  bounty_arg := case when inst.pricing_type = 'fixed_bounty' then p_bounty end;

  new_owner := case when p_assigned_to is distinct from inst.assigned_to then p_assigned_to end;
  changed := has_comp and (
    (p_total_minutes is not null and p_total_minutes is distinct from comp.total_duration_minutes)
    or (tax_arg is not null and tax_arg is distinct from inst.chore_tax)
    or (bounty_arg is not null and bounty_arg is distinct from inst.fixed_bounty_points)
    or new_owner is not null
    or (p_owner_percent is not null and p_owner_percent is distinct from comp.owner_percent)
  );

  perform set_config('duosync.skip_assign_notify', 'on', true);

  update public.chore_instances
  set title = new_title, assigned_to = coalesce(p_assigned_to, assigned_to), scheduled_date = p_scheduled_date,
      chore_tax = coalesce(tax_arg, chore_tax), fixed_bounty_points = coalesce(bounty_arg, fixed_bounty_points)
  where id = inst.id;

  if changed then
    select display_name into caller_name from public.profiles where id = uid;
    for r in select * from public.reprice_completion(inst.id, p_total_minutes, tax_arg, new_owner, p_owner_percent, bounty_arg) loop
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

revoke all on function public.edit_completed_chore(uuid, text, uuid, date, integer, integer, integer, integer) from public, anon;
grant execute on function public.edit_completed_chore(uuid, text, uuid, date, integer, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Library: create / edit with a pricing model
-- ---------------------------------------------------------------------------
drop function public.create_library_chore(text, text, integer, integer);

create function public.create_library_chore(
  p_title text, p_category text, p_duration integer, p_tax integer,
  p_pricing_type public.chore_pricing_type default 'time_based', p_bounty integer default 15
) returns public.chore_library
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  new_title text := trim(coalesce(p_title, ''));
  new_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'General');
  result public.chore_library;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if char_length(new_title) > 60 then raise exception 'Keep the name to 60 characters or fewer'; end if;
  if char_length(new_category) > 30 then raise exception 'Keep the category to 30 characters or fewer'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;
  if p_bounty is null or p_bounty < 1 or p_bounty > 500 then raise exception 'Bounty must be between 1 and 500 points'; end if;
  if exists (
    select 1 from public.chore_library
    where household_id = hh and not coalesce(is_archived, false) and lower(title) = lower(new_title)
  ) then
    raise exception 'You already have a chore called "%"', new_title;
  end if;

  -- last_used_at stays null so "Recent" only shows chores that have really been scheduled.
  insert into public.chore_library (
    household_id, title, category, default_duration, chore_tax, pricing_type, fixed_bounty_points, last_used_at
  ) values (
    hh, new_title, new_category, p_duration,
    case when p_pricing_type = 'fixed_bounty' then 0 else p_tax end, -- a mission has no chore tax
    coalesce(p_pricing_type, 'time_based'), p_bounty, null
  ) returning * into result;
  return result;
end $$;

revoke all on function public.create_library_chore(text, text, integer, integer, public.chore_pricing_type, integer) from public, anon;
grant execute on function public.create_library_chore(text, text, integer, integer, public.chore_pricing_type, integer) to authenticated;

-- Edit + push across the board (0009). Each field pushes only if it changed:
--   name          -> every copy (finished ones too) and every repeating series
--   time          -> unfinished copies and series (finished copies keep the time actually logged)
--   tax           -> unfinished copies and series; finished TIME-BASED copies are re-priced
--   bounty        -> unfinished copies and series; finished FIXED copies are re-priced
--   pricing model -> unfinished copies and series only. History keeps the model it was paid under.
drop function public.update_library_chore(uuid, text, text, integer, integer, boolean);

create function public.update_library_chore(
  p_chore_id uuid, p_title text, p_category text, p_duration integer, p_tax integer,
  p_reprice_finished boolean default true,
  p_pricing_type public.chore_pricing_type default null, p_bounty integer default null
) returns table (n_open integer, n_series integer, n_done integer, my_delta integer, their_delta integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  lib public.chore_library;
  new_title text := trim(coalesce(p_title, ''));
  new_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'General');
  new_pricing public.chore_pricing_type;
  new_bounty integer;
  new_tax integer;
  title_changed boolean;
  time_changed boolean;
  tax_changed boolean;
  pricing_changed boolean;
  bounty_changed boolean;
  do_reprice boolean;
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

  new_pricing := coalesce(p_pricing_type, lib.pricing_type);
  new_bounty := coalesce(p_bounty, lib.fixed_bounty_points);
  if new_bounty < 1 or new_bounty > 500 then raise exception 'Bounty must be between 1 and 500 points'; end if;
  -- The tax only means something for a time-based chore; a mission keeps whatever it had.
  new_tax := case when new_pricing = 'time_based' then p_tax else lib.chore_tax end;

  if exists (
    select 1 from public.chore_library
    where household_id = hh and id <> lib.id and not coalesce(is_archived, false)
      and lower(title) = lower(new_title)
  ) then
    raise exception 'You already have a chore called "%"', new_title;
  end if;

  title_changed := new_title is distinct from lib.title;
  time_changed := p_duration is distinct from lib.default_duration;
  tax_changed := new_tax is distinct from lib.chore_tax;
  pricing_changed := new_pricing is distinct from lib.pricing_type;
  bounty_changed := new_bounty is distinct from lib.fixed_bounty_points;

  update public.chore_library
  set title = new_title, category = new_category, default_duration = p_duration, chore_tax = new_tax,
      pricing_type = new_pricing, fixed_bounty_points = new_bounty
  where id = lib.id;

  n_open := 0; n_series := 0; n_done := 0; my_delta := 0; their_delta := 0;
  if not (title_changed or time_changed or tax_changed or pricing_changed or bounty_changed) then
    return next;
    return;
  end if;

  -- Unfinished copies: whatever changed follows the library.
  update public.chore_instances
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then new_tax else chore_tax end,
      pricing_type = case when pricing_changed then new_pricing else pricing_type end,
      fixed_bounty_points = case when bounty_changed then new_bounty else fixed_bounty_points end
  where chore_id = lib.id and household_id = hh and not is_completed;
  get diagnostics n_open = row_count;

  -- Finished copies: the name and the estimate follow. A tax change re-prices time-based ones and a bounty
  -- change re-prices fixed ones, adjusting balances by the difference. A change of pricing model never does.
  for c in
    select id, pricing_type from public.chore_instances where chore_id = lib.id and household_id = hh and is_completed
  loop
    do_reprice := coalesce(p_reprice_finished, true)
      and ((c.pricing_type = 'time_based' and tax_changed) or (c.pricing_type = 'fixed_bounty' and bounty_changed));

    update public.chore_instances
    set title = case when title_changed then new_title else title end,
        estimated_duration = case when time_changed then p_duration else estimated_duration end,
        chore_tax = case when do_reprice and c.pricing_type = 'time_based' then new_tax else chore_tax end,
        fixed_bounty_points = case when do_reprice and c.pricing_type = 'fixed_bounty' then new_bounty else fixed_bounty_points end
    where id = c.id;

    if do_reprice then
      n_done := n_done + 1;
      for r in select * from public.reprice_completion(c.id, null, null, null, null, null) loop
        if r.o_user = uid then my_delta := my_delta + r.o_delta; else their_delta := their_delta + r.o_delta; end if;
      end loop;
    end if;
  end loop;

  -- Repeating series, so the days generated from now on carry the new values too.
  update public.chore_series
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then new_tax else chore_tax end,
      pricing_type = case when pricing_changed then new_pricing else pricing_type end,
      fixed_bounty_points = case when bounty_changed then new_bounty else fixed_bounty_points end
  where chore_id = lib.id and household_id = hh and (end_date is null or end_date >= current_date);
  get diagnostics n_series = row_count;

  if their_delta <> 0 then
    select id into partner from public.profiles where household_id = hh and id <> uid limit 1;
    select display_name into caller_name from public.profiles where id = uid;
    if partner is not null then
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (
        partner, uid, 'points_adjusted', lib.id,
        caller_name || ' changed the reward on ' || new_title || ': your balance '
          || case when their_delta > 0 then 'went up by ' else 'went down by ' end || abs(their_delta)
          || ' pts across ' || n_done || case when n_done = 1 then ' finished chore' else ' finished chores' end
      );
    end if;
  end if;

  return next;
end $$;

revoke all on function public.update_library_chore(uuid, text, text, integer, integer, boolean, public.chore_pricing_type, integer) from public, anon;
grant execute on function public.update_library_chore(uuid, text, text, integer, integer, boolean, public.chore_pricing_type, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Repeating chores carry their pricing model into every generated day
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
        is_recurring, recurrence_rule, parent_recurrence_id, estimated_duration, chore_tax,
        pricing_type, fixed_bounty_points
      ) values (
        s.chore_id, s.title, s.household_id, s.assigned_to, d,
        true, public.series_rule(s.frequency), s.id, s.estimated_duration, s.chore_tax,
        s.pricing_type, s.fixed_bounty_points
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
    household_id, chore_id, title, estimated_duration, chore_tax, pricing_type, fixed_bounty_points,
    assigned_to, frequency, start_date, generated_through
  ) values (
    hh, inst.chore_id, inst.title, inst.estimated_duration, inst.chore_tax, inst.pricing_type, inst.fixed_bounty_points,
    inst.assigned_to, p_frequency, inst.scheduled_date, inst.scheduled_date
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

-- "This and future": title / time / tax / pricing / assignee for this occurrence and every later unfinished
-- one; can also change how often it repeats ('none' stops the series). Body as 0006 plus the pricing model.
drop function public.update_chore_series(uuid, text, integer, integer, uuid, text);

create function public.update_chore_series(
  p_instance_id uuid, p_title text, p_duration integer, p_tax integer, p_assigned_to uuid, p_frequency text,
  p_pricing_type public.chore_pricing_type default null, p_bounty integer default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  s public.chore_series;
  my_name text;
  new_title text := trim(coalesce(p_title, ''));
  new_pricing public.chore_pricing_type;
  new_bounty integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;
  if p_bounty is not null and (p_bounty < 1 or p_bounty > 500) then raise exception 'Bounty must be between 1 and 500 points'; end if;
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

  new_pricing := coalesce(p_pricing_type, s.pricing_type);
  new_bounty := coalesce(p_bounty, s.fixed_bounty_points);

  perform set_config('duosync.skip_assign_notify', 'on', true);

  update public.chore_series
  set title = new_title, estimated_duration = p_duration, chore_tax = p_tax, assigned_to = p_assigned_to,
      pricing_type = new_pricing, fixed_bounty_points = new_bounty
  where id = s.id;

  update public.chore_instances
  set title = new_title, estimated_duration = p_duration, chore_tax = p_tax, assigned_to = p_assigned_to,
      pricing_type = new_pricing, fixed_bounty_points = new_bounty
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

revoke all on function public.update_chore_series(uuid, text, integer, integer, uuid, text, public.chore_pricing_type, integer) from public, anon;
grant execute on function public.update_chore_series(uuid, text, integer, integer, uuid, text, public.chore_pricing_type, integer) to authenticated;
