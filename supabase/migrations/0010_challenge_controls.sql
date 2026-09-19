-- Full control over challenges: adjust progress (including undoing a completed one), edit, reassign, delete.
--
-- Either partner can manage any challenge in the household. Anything that changes what was paid out
-- goes through the same ledger rule as chores: the difference is credited or debited straight away.
-- (A balance never goes below 0 - if the points were already spent, it stops at 0.)
--
--   * set_challenge_progress()  - the "-" / "+" on the card. Lowering a completed challenge REOPENS it
--                                 and takes the reward back; reaching the target completes and pays.
--                                 Raising progress stays with the person the challenge is for.
--   * update_challenge()        - name, target, reward and who it is for. On a completed challenge only
--                                 the name, reward and assignee can change (the payout follows).
--   * delete_challenge()        - removes it; a completed one has its reward taken back.
--
-- Adds three functions; changes nothing that exists. Run 0001-0009 first.

-- ---------------------------------------------------------------------------
-- Internal: move a challenge's reward between balances and tell the person, if it is not the caller.
-- ---------------------------------------------------------------------------
create function public.adjust_points(p_user uuid, p_delta integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  before_pts integer;
  after_pts integer;
begin
  select points into before_pts from public.profiles where id = p_user;
  update public.profiles set points = greatest(points + p_delta, 0) where id = p_user;
  select points into after_pts from public.profiles where id = p_user;
  return after_pts - before_pts;
end $$;

revoke all on function public.adjust_points(uuid, integer) from public, anon, authenticated;

create function public.notify_points_adjusted(p_recipient uuid, p_actor uuid, p_ref uuid, p_what text, p_delta integer)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor_name text;
begin
  if p_recipient is null or p_recipient = p_actor or p_delta = 0 then return; end if;
  select display_name into actor_name from public.profiles where id = p_actor;
  insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
  values (
    p_recipient, p_actor, 'points_adjusted', p_ref,
    actor_name || ' ' || p_what || ': your balance ' || case when p_delta > 0 then 'went up by ' else 'went down by ' end
      || abs(p_delta) || ' pts'
  );
end $$;

revoke all on function public.notify_points_adjusted(uuid, uuid, uuid, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Progress: the - and + on a challenge
-- ---------------------------------------------------------------------------
create function public.set_challenge_progress(p_challenge_id uuid, p_count integer)
returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  actor_name text;
  applied integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into ch from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;
  if ch.status not in ('active', 'completed') then raise exception 'That challenge is not running'; end if;
  if p_count is null or p_count < 0 or p_count > ch.target_count then
    raise exception 'Progress must be between 0 and %', ch.target_count;
  end if;
  if p_count > ch.current_count and ch.status = 'active' and uid <> ch.assigned_to then
    raise exception 'Only the person the challenge is for can log progress';
  end if;

  if ch.status = 'completed' then
    if p_count >= ch.target_count then return ch; end if; -- already done
    -- Reopen: back to active at the lower count, reward taken back.
    update public.challenges
    set status = 'active', completed_at = null, current_count = p_count
    where id = ch.id returning * into ch;
    applied := public.adjust_points(ch.assigned_to, -ch.reward_points);
    perform public.notify_points_adjusted(ch.assigned_to, uid, ch.id, 'reopened "' || ch.title || '"', applied);
    return ch;
  end if;

  if p_count >= ch.target_count then
    -- Reaching the target completes it and pays the person it is for.
    update public.challenges
    set current_count = target_count, status = 'completed', completed_at = now()
    where id = ch.id returning * into ch;
    perform public.adjust_points(ch.assigned_to, ch.reward_points);
    if ch.creator_id <> ch.assigned_to and ch.creator_id <> uid then
      select display_name into actor_name from public.profiles where id = uid;
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (ch.creator_id, uid, 'challenge_completed', ch.id, actor_name || ' completed your challenge: ' || ch.title);
    end if;
  else
    update public.challenges set current_count = p_count where id = ch.id returning * into ch;
  end if;
  return ch;
end $$;

revoke all on function public.set_challenge_progress(uuid, integer) from public, anon;
grant execute on function public.set_challenge_progress(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Edit / reassign
-- ---------------------------------------------------------------------------
create function public.update_challenge(
  p_challenge_id uuid, p_title text, p_target_count integer, p_reward_points integer, p_assigned_to uuid
) returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  prev public.challenges;
  new_title text := trim(coalesce(p_title, ''));
  actor_name text;
  applied integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the challenge a name'; end if;
  if char_length(new_title) > 80 then raise exception 'Keep the name to 80 characters or fewer'; end if;
  if p_target_count is null or p_target_count < 1 or p_target_count > 1000 then
    raise exception 'Target must be between 1 and 1000';
  end if;
  if p_reward_points is null or p_reward_points < 1 or p_reward_points > 500 then
    raise exception 'Reward must be between 1 and 500 points';
  end if;
  if p_assigned_to is null or not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;

  select * into prev from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;
  ch := prev;

  if prev.status = 'completed' then
    -- The payout was made for this many repetitions, so the target is fixed until it is reopened.
    if p_target_count <> prev.target_count then
      raise exception 'Reduce the progress first (the - button) to change how many times';
    end if;
    update public.challenges
    set title = new_title, reward_points = p_reward_points, assigned_to = p_assigned_to
    where id = prev.id returning * into ch;

    -- Ledger: take the old reward from whoever got it, pay the new one to whoever has it now.
    if prev.assigned_to = p_assigned_to then
      applied := public.adjust_points(p_assigned_to, p_reward_points - prev.reward_points);
      perform public.notify_points_adjusted(p_assigned_to, uid, ch.id, 'changed the reward on "' || new_title || '"', applied);
    else
      applied := public.adjust_points(prev.assigned_to, -prev.reward_points);
      perform public.notify_points_adjusted(prev.assigned_to, uid, ch.id, 'gave "' || new_title || '" to someone else', applied);
      applied := public.adjust_points(p_assigned_to, p_reward_points);
      perform public.notify_points_adjusted(p_assigned_to, uid, ch.id, 'gave you "' || new_title || '"', applied);
    end if;
    return ch;
  end if;

  if p_target_count < prev.current_count then
    raise exception 'Progress is already % - reduce it first to go lower than that', prev.current_count;
  end if;

  update public.challenges
  set title = new_title, target_count = p_target_count, reward_points = p_reward_points, assigned_to = p_assigned_to
  where id = prev.id returning * into ch;

  if p_assigned_to <> prev.assigned_to then
    -- Handing it to someone new: whoever does that is proposing it, and the new person has to accept
    -- (unless they gave it to themselves). Progress made so far is kept.
    update public.challenges
    set creator_id = uid, status = case when p_assigned_to = uid then 'active' else 'pending' end
    where id = ch.id returning * into ch;

    delete from public.notifications where reference_id = ch.id and type = 'challenge_proposed';
    if p_assigned_to <> uid then
      select display_name into actor_name from public.profiles where id = uid;
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (p_assigned_to, uid, 'challenge_proposed', ch.id, actor_name || ' set a challenge for you: ' || ch.title);
    end if;
  end if;

  -- Lowering the target down to the current progress finishes it.
  if ch.status = 'active' and ch.current_count >= ch.target_count then
    update public.challenges set status = 'completed', completed_at = now() where id = ch.id returning * into ch;
    perform public.adjust_points(ch.assigned_to, ch.reward_points);
  end if;

  return ch;
end $$;

revoke all on function public.update_challenge(uuid, text, integer, integer, uuid) from public, anon;
grant execute on function public.update_challenge(uuid, text, integer, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Delete
-- ---------------------------------------------------------------------------
create function public.delete_challenge(p_challenge_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  taken integer := 0;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into ch from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;

  if ch.status = 'completed' then
    -- It disappears from Stats too, so the reward it paid is taken back (as when a finished chore is deleted).
    taken := -public.adjust_points(ch.assigned_to, -ch.reward_points);
    perform public.notify_points_adjusted(ch.assigned_to, uid, ch.id, 'deleted "' || ch.title || '"', -taken);
  end if;

  delete from public.notifications
  where reference_id = ch.id
    and type in ('challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed');
  delete from public.challenges where id = ch.id;

  return taken;
end $$;

revoke all on function public.delete_challenge(uuid) from public, anon;
grant execute on function public.delete_challenge(uuid) to authenticated;
