-- Completing a chore credits the person it is assigned to, whoever taps "Complete".
--
-- Before: the caller was always "user A" and got the default 100%, so completing your partner's
-- chore handed the points to you. Now the chore's owner is user A:
--   * assigned chore     -> the assignee is A; assigned_to is never changed by completing it
--   * unassigned chore   -> the caller is A and claims it (assigned_to = caller), as before
--
-- The p_my_percent argument keeps its name so older clients keep working, but it now means
-- "the OWNER's share" (0-100, multiples of 10). For your own chores and unassigned ones the
-- owner is the caller, so nothing changes there. The split is still exact: owner = round(total*pct),
-- the other person gets the remainder, for both points and minutes.
--
-- Replaces one function. Run 0001-0006 first.

create or replace function public.complete_chore(
  p_instance_id uuid, p_total_minutes integer, p_my_percent integer default 100
) returns public.chore_completions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  owner uuid;          -- whose chore it is: gets the credit
  other uuid;          -- the other person in the household (null in a solo household)
  partner uuid;        -- anyone in the household who is not the caller
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
  if owner = uid then
    other := partner;
  else
    other := uid; -- completing your partner's chore: they keep the chore, you are the "other" share
  end if;
  if other is null then
    if p_my_percent <> 100 then raise exception 'There is no partner to split with yet'; end if;
    other := owner; -- solo household: the other slot mirrors the owner with a zero share
  end if;

  total_pts := public.chore_points(p_total_minutes, inst.chore_tax);
  own_min := round(p_total_minutes * p_my_percent / 100.0);
  oth_min := p_total_minutes - own_min;
  own_pts := round(total_pts * p_my_percent / 100.0);
  oth_pts := total_pts - own_pts;

  insert into public.chore_completions (
    instance_id, total_duration_minutes,
    user_a_id, user_a_duration, user_a_points,
    user_b_id, user_b_duration, user_b_points
  ) values (
    inst.id, p_total_minutes, owner, own_min, own_pts, other, oth_min, oth_pts
  ) returning * into result;

  update public.chore_instances
  set is_completed = true, completed_at = now(), assigned_to = owner
  where id = inst.id;

  update public.profiles set points = points + own_pts where id = owner;
  if other <> owner then
    update public.profiles set points = points + oth_pts where id = other;
  end if;

  -- Tell the other person (never the caller) what happened and what they earned.
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
