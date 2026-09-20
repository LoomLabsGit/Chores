-- Forfeit challenges, joint challenges and automatic settlement of deadlines.
--
-- FORFEIT ("hold the line"): an anti-behaviour framed up front. The target count is the number of repetitions
--   needed before deadline_date. Success pays nothing (the status quo); missing the deadline docks
--   penalty_points from the assignee. A forfeit needs a deadline and a penalty, is for one person, and - because
--   it costs points - a forfeit set for your partner has to be accepted first, like any proposal.
-- JOINT: both partners share the challenge. It starts active for both at once (no acceptance) and either can log
--   progress; current_count is the total and completed_by_a/b_count the individual contributions ("a" is the
--   household creator, "b" the partner). On completion each partner is credited round(reward / 2).
--   Joint + forfeit is deliberately not offered: it would dock a partner who never agreed to it.
-- SETTLEMENT: an active challenge whose deadline has passed is settled once. Missed forfeit -> penalty (never below
--   0), a ledger line and a notification, status 'expired_penalized'. Any other unfinished challenge simply
--   becomes 'expired' with no penalty (a reward challenge with a deadline it missed, or a proposal nobody accepted
--   in time). "Midnight" is the household's own midnight (households.timezone, default Europe/London).
--   Settlement runs hourly from pg_cron where the extension is available, and also whenever either partner opens
--   the app (settle_my_challenges), so it never depends on the schedule alone. It is idempotent.
--
-- Balance changes from challenges now go through the point ledger (0011). Run 0001-0012 first.

create type public.challenge_type as enum ('reward', 'forfeit');

alter table public.challenges
  add column type public.challenge_type not null default 'reward',
  add column is_joint boolean not null default false,
  add column deadline_date date,
  add column penalty_points integer not null default 0 check (penalty_points between 0 and 500),
  add column completed_by_a_count integer not null default 0 check (completed_by_a_count >= 0),
  add column completed_by_b_count integer not null default 0 check (completed_by_b_count >= 0);

-- A forfeit always has a deadline and a penalty, and is never joint.
alter table public.challenges add constraint challenges_forfeit_shape
  check (type <> 'forfeit' or (deadline_date is not null and penalty_points >= 1 and not is_joint));

alter table public.challenges drop constraint challenges_status_check;
alter table public.challenges add constraint challenges_status_check
  check (status in ('pending', 'active', 'completed', 'rejected', 'expired', 'expired_penalized'));

alter table public.households add column timezone text not null default 'Europe/London';

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'chore_assigned', 'chore_completed',
  'challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed',
  'reward_redeemed', 'points_adjusted', 'challenge_expired'
));

-- ---------------------------------------------------------------------------
-- Helpers (internal)
-- ---------------------------------------------------------------------------

-- Today, on the household's own clock.
create function public.household_today(p_household uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce((select timezone from public.households where id = p_household), 'Europe/London'))::date
$$;
revoke all on function public.household_today(uuid) from public, anon, authenticated;

-- Each partner's half of a joint reward: round(reward / 2).
create function public.challenge_half(p_reward integer) returns integer
language sql immutable as $$ select round(p_reward / 2.0)::integer $$;

-- Pay (p_sign = 1) or take back (p_sign = -1) a challenge's reward through the ledger: to the assignee, or
-- half each for a joint challenge. When p_what is given, whoever is not the caller is told what happened to
-- their balance. Returns the total real change (after the zero floor).
create function public.pay_challenge(
  p_ch public.challenges, p_sign integer, p_reason text, p_actor uuid, p_what text default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  m uuid;
  amount integer;
  applied integer;
  total integer := 0;
begin
  if p_ch.reward_points <= 0 then return 0; end if;
  amount := case when p_ch.is_joint then public.challenge_half(p_ch.reward_points) else p_ch.reward_points end;
  for m in
    select id from public.profiles
    where household_id = p_ch.household_id and (p_ch.is_joint or id = p_ch.assigned_to)
  loop
    applied := public.apply_points(m, p_sign * amount, p_reason, p_ch.id);
    total := total + applied;
    if p_what is not null then
      perform public.notify_points_adjusted(m, p_actor, p_ch.id, p_what, applied);
    end if;
  end loop;
  return total;
end $$;
revoke all on function public.pay_challenge(public.challenges, integer, text, uuid, text) from public, anon, authenticated;

-- A challenge has just reached its target: pay it out (nothing for a forfeit) and tell the other person.
create function public.finish_challenge(p_ch public.challenges, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor_name text;
  other uuid;
begin
  perform public.pay_challenge(p_ch, 1, 'Challenge completed: ' || p_ch.title, p_actor);
  select display_name into actor_name from public.profiles where id = p_actor;

  if p_ch.is_joint then
    select id into other from public.profiles where household_id = p_ch.household_id and id <> p_actor limit 1;
    if other is not null then
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (
        other, p_actor, 'challenge_completed', p_ch.id,
        actor_name || ' finished your joint challenge: ' || p_ch.title
          || ' - you each earn ' || public.challenge_half(p_ch.reward_points) || ' pts'
      );
    end if;
  elsif p_ch.creator_id <> p_ch.assigned_to and p_ch.creator_id <> p_actor then
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      p_ch.creator_id, p_actor, 'challenge_completed', p_ch.id,
      actor_name || case when p_ch.type = 'forfeit' then ' held the line on your forfeit challenge: '
                         else ' completed your challenge: ' end || p_ch.title
    );
  end if;
end $$;
revoke all on function public.finish_challenge(public.challenges, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
drop function public.create_challenge(text, uuid, integer, integer);

create function public.create_challenge(
  p_title text, p_assigned_to uuid, p_target_count integer, p_reward_points integer,
  p_type public.challenge_type default 'reward', p_is_joint boolean default false,
  p_deadline_date date default null, p_penalty_points integer default 0
) returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  my_name text;
  partner uuid;
  kind public.challenge_type := coalesce(p_type, 'reward');
  joint boolean := coalesce(p_is_joint, false);
  reward integer := p_reward_points;
  penalty integer := coalesce(p_penalty_points, 0);
  assignee uuid := p_assigned_to;
  result public.challenges;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the challenge a name'; end if;
  if char_length(trim(p_title)) > 80 then raise exception 'Keep the name to 80 characters or fewer'; end if;
  if p_target_count is null or p_target_count < 1 or p_target_count > 1000 then
    raise exception 'Target must be between 1 and 1000';
  end if;
  if p_deadline_date is not null and p_deadline_date < public.household_today(hh) then
    raise exception 'Pick a deadline that has not passed';
  end if;

  if kind = 'forfeit' then
    if joint then raise exception 'A forfeit challenge is for one person'; end if;
    if p_deadline_date is null then raise exception 'A forfeit challenge needs a deadline'; end if;
    if penalty < 1 or penalty > 500 then raise exception 'The penalty must be between 1 and 500 points'; end if;
    reward := 0; -- holding the line earns nothing: it just avoids the penalty
  else
    if reward is null or reward < 1 or reward > 500 then raise exception 'Reward must be between 1 and 500 points'; end if;
    penalty := 0;
  end if;

  select id into partner from public.profiles where household_id = hh and id <> uid limit 1;
  if joint then
    if partner is null then raise exception 'Invite your partner first to set a joint challenge'; end if;
    assignee := uid; -- a joint challenge belongs to both; the creator is recorded as its owner
  elsif assignee is null or not public.is_household_member(assignee) then
    raise exception 'Assignee is not in your household';
  end if;

  insert into public.challenges (
    household_id, creator_id, assigned_to, title, target_count, reward_points, status,
    type, is_joint, deadline_date, penalty_points
  ) values (
    hh, uid, assignee, trim(p_title), p_target_count, reward,
    case when joint or assignee = uid then 'active' else 'pending' end,
    kind, joint, p_deadline_date, penalty
  ) returning * into result;

  select display_name into my_name from public.profiles where id = uid;
  if joint then
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (partner, uid, 'challenge_proposed', result.id, my_name || ' started a joint challenge with you: ' || result.title);
  elsif assignee <> uid then
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      assignee, uid, 'challenge_proposed', result.id,
      my_name || case when kind = 'forfeit' then ' set a forfeit challenge for you: ' else ' set a challenge for you: ' end
        || result.title
    );
  end if;

  return result;
end $$;

revoke all on function public.create_challenge(text, uuid, integer, integer, public.challenge_type, boolean, date, integer) from public, anon;
grant execute on function public.create_challenge(text, uuid, integer, integer, public.challenge_type, boolean, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Accept / decline (body as 0001, plus: a proposal whose deadline has passed can no longer be accepted)
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_challenge(p_challenge_id uuid, p_accept boolean)
returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  my_name text;
  result public.challenges;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into result from public.challenges
  where id = p_challenge_id and household_id = hh and assigned_to = uid and status = 'pending'
  for update;
  if not found then raise exception 'No pending challenge to respond to'; end if;
  if p_accept and result.deadline_date is not null and result.deadline_date < public.household_today(hh) then
    raise exception 'The deadline for that challenge has already passed';
  end if;

  update public.challenges
  set status = case when p_accept then 'active' else 'rejected' end
  where id = result.id
  returning * into result;

  update public.notifications set is_read = true
  where recipient_id = uid and type = 'challenge_proposed' and reference_id = result.id;

  if result.creator_id <> uid then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      result.creator_id, uid,
      case when p_accept then 'challenge_accepted' else 'challenge_declined' end,
      result.id,
      my_name || case when p_accept then ' accepted' else ' declined' end
        || ' your challenge: ' || result.title
    );
  end if;

  return result;
end $$;

-- ---------------------------------------------------------------------------
-- Log one repetition. Individual challenges: only the person it is for. Joint: either partner.
-- ---------------------------------------------------------------------------
create or replace function public.increment_challenge(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  i_am_a boolean;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into ch from public.challenges where id = p_challenge_id and household_id = hh and status = 'active' for update;
  if not found or (not ch.is_joint and ch.assigned_to <> uid) then
    raise exception 'That challenge is not active for you';
  end if;
  if ch.deadline_date is not null and ch.deadline_date < public.household_today(hh) then
    raise exception 'The deadline for that challenge has passed';
  end if;

  select is_admin into i_am_a from public.profiles where id = uid;

  update public.challenges
  set current_count = current_count + 1,
      completed_by_a_count = completed_by_a_count + case when is_joint and i_am_a then 1 else 0 end,
      completed_by_b_count = completed_by_b_count + case when is_joint and not i_am_a then 1 else 0 end,
      status = case when current_count + 1 >= target_count then 'completed' else status end,
      completed_at = case when current_count + 1 >= target_count then now() else completed_at end
  where id = ch.id
  returning * into ch;

  if ch.status = 'completed' then perform public.finish_challenge(ch, uid); end if;
  return ch;
end $$;

-- ---------------------------------------------------------------------------
-- Set progress: the - and + on a card, reset, and undoing a finished challenge
-- ---------------------------------------------------------------------------
create or replace function public.set_challenge_progress(p_challenge_id uuid, p_count integer)
returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  i_am_a boolean;
  diff integer;
  a integer; b integer; mine integer; theirs integer; take integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into ch from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;
  if ch.status not in ('active', 'completed') then raise exception 'That challenge is not running'; end if;
  if p_count is null or p_count < 0 or p_count > ch.target_count then
    raise exception 'Progress must be between 0 and %', ch.target_count;
  end if;

  diff := p_count - ch.current_count;
  if diff > 0 and ch.status = 'active' and not ch.is_joint and uid <> ch.assigned_to then
    raise exception 'Only the person the challenge is for can log progress';
  end if;
  -- Progress and reopening both stop at the deadline: a forfeit that was held must not be reopened into a penalty.
  if (diff > 0 or ch.status = 'completed') and ch.deadline_date is not null
     and ch.deadline_date < public.household_today(hh) and not (ch.status = 'completed' and p_count >= ch.target_count) then
    raise exception 'The deadline for that challenge has passed';
  end if;

  -- Joint: keep each partner's contribution in step with the total. Adding counts for the person tapping;
  -- taking away comes off their own count first, then their partner's.
  select is_admin into i_am_a from public.profiles where id = uid;
  a := ch.completed_by_a_count; b := ch.completed_by_b_count;
  if ch.is_joint and diff <> 0 then
    mine := case when i_am_a then a else b end;
    theirs := case when i_am_a then b else a end;
    if diff > 0 then
      mine := mine + diff;
    else
      take := least(mine, -diff);
      mine := mine - take;
      theirs := greatest(theirs - (-diff - take), 0);
    end if;
    a := case when i_am_a then mine else theirs end;
    b := case when i_am_a then theirs else mine end;
  end if;

  if ch.status = 'completed' then
    if p_count >= ch.target_count then return ch; end if; -- already done
    update public.challenges
    set status = 'active', completed_at = null, current_count = p_count, completed_by_a_count = a, completed_by_b_count = b
    where id = ch.id returning * into ch;
    perform public.pay_challenge(ch, -1, 'Challenge reopened: ' || ch.title, uid, 'reopened "' || ch.title || '"');
    return ch;
  end if;

  if p_count >= ch.target_count then
    update public.challenges
    set current_count = target_count, completed_by_a_count = a, completed_by_b_count = b,
        status = 'completed', completed_at = now()
    where id = ch.id returning * into ch;
    perform public.finish_challenge(ch, uid);
  else
    update public.challenges
    set current_count = p_count, completed_by_a_count = a, completed_by_b_count = b
    where id = ch.id returning * into ch;
  end if;
  return ch;
end $$;

-- ---------------------------------------------------------------------------
-- Edit / reassign. The kind (reward or forfeit) and the scope (individual or joint) are fixed for life: change
-- either by deleting the challenge and making a new one. A finished challenge only takes a new name, reward or
-- person (the payout follows); an expired one can only be deleted.
-- ---------------------------------------------------------------------------
drop function public.update_challenge(uuid, text, integer, integer, uuid);

create function public.update_challenge(
  p_challenge_id uuid, p_title text, p_target_count integer, p_reward_points integer, p_assigned_to uuid,
  p_deadline_date date default null, p_penalty_points integer default null
) returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  prev public.challenges;
  new_title text := trim(coalesce(p_title, ''));
  new_reward integer;
  new_penalty integer;
  actor_name text;
  applied integer;
  m uuid;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the challenge a name'; end if;
  if char_length(new_title) > 80 then raise exception 'Keep the name to 80 characters or fewer'; end if;
  if p_target_count is null or p_target_count < 1 or p_target_count > 1000 then
    raise exception 'Target must be between 1 and 1000';
  end if;
  if p_assigned_to is null or not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;

  select * into prev from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;
  if prev.status in ('expired', 'expired_penalized') then
    raise exception 'That challenge has ended. You can delete it';
  end if;
  if prev.is_joint and p_assigned_to <> prev.assigned_to then
    raise exception 'A joint challenge belongs to both of you';
  end if;

  if prev.type = 'forfeit' then
    new_reward := 0;
    new_penalty := coalesce(p_penalty_points, prev.penalty_points);
    if new_penalty < 1 or new_penalty > 500 then raise exception 'The penalty must be between 1 and 500 points'; end if;
  else
    new_reward := p_reward_points;
    new_penalty := 0;
    if new_reward is null or new_reward < 1 or new_reward > 500 then raise exception 'Reward must be between 1 and 500 points'; end if;
  end if;

  ch := prev;

  if prev.status = 'completed' then
    -- The payout was made for this many repetitions, so the target is fixed until it is reopened.
    if p_target_count <> prev.target_count then
      raise exception 'Reduce the progress first (the - button) to change how many times';
    end if;
    update public.challenges
    set title = new_title, reward_points = new_reward, assigned_to = p_assigned_to
    where id = prev.id returning * into ch;

    -- Ledger: what was paid is corrected to what the challenge now pays.
    if new_reward <> prev.reward_points or p_assigned_to <> prev.assigned_to then
      if prev.is_joint then
        for m in select id from public.profiles where household_id = hh loop
          applied := public.apply_points(m, public.challenge_half(new_reward) - public.challenge_half(prev.reward_points),
                                         'Challenge reward changed: ' || new_title, ch.id);
          perform public.notify_points_adjusted(m, uid, ch.id, 'changed the reward on "' || new_title || '"', applied);
        end loop;
      elsif prev.assigned_to = p_assigned_to then
        applied := public.apply_points(p_assigned_to, new_reward - prev.reward_points, 'Challenge reward changed: ' || new_title, ch.id);
        perform public.notify_points_adjusted(p_assigned_to, uid, ch.id, 'changed the reward on "' || new_title || '"', applied);
      else
        applied := public.apply_points(prev.assigned_to, -prev.reward_points, 'Challenge given away: ' || new_title, ch.id);
        perform public.notify_points_adjusted(prev.assigned_to, uid, ch.id, 'gave "' || new_title || '" to someone else', applied);
        applied := public.apply_points(p_assigned_to, new_reward, 'Challenge received: ' || new_title, ch.id);
        perform public.notify_points_adjusted(p_assigned_to, uid, ch.id, 'gave you "' || new_title || '"', applied);
      end if;
    end if;
    return ch;
  end if;

  if p_target_count < prev.current_count then
    raise exception 'Progress is already % - reduce it first to go lower than that', prev.current_count;
  end if;
  if prev.type = 'forfeit' and p_deadline_date is null then raise exception 'A forfeit challenge needs a deadline'; end if;
  if p_deadline_date is not null and p_deadline_date is distinct from prev.deadline_date
     and p_deadline_date < public.household_today(hh) then
    raise exception 'Pick a deadline that has not passed';
  end if;

  update public.challenges
  set title = new_title, target_count = p_target_count, reward_points = new_reward, penalty_points = new_penalty,
      deadline_date = p_deadline_date, assigned_to = p_assigned_to
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
      values (
        p_assigned_to, uid, 'challenge_proposed', ch.id,
        actor_name || case when ch.type = 'forfeit' then ' set a forfeit challenge for you: ' else ' set a challenge for you: ' end || ch.title
      );
    end if;
  end if;

  -- Lowering the target down to the current progress finishes it.
  if ch.status = 'active' and ch.current_count >= ch.target_count then
    update public.challenges set status = 'completed', completed_at = now() where id = ch.id returning * into ch;
    perform public.finish_challenge(ch, uid);
  end if;

  return ch;
end $$;

revoke all on function public.update_challenge(uuid, text, integer, integer, uuid, date, integer) from public, anon;
grant execute on function public.update_challenge(uuid, text, integer, integer, uuid, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Delete. Deleting undoes what the challenge did to balances: a finished one gives back its reward (as before)
-- and a missed forfeit gives back the points that were docked. Resolves to the points taken back (positive) or
-- refunded (negative).
-- ---------------------------------------------------------------------------
create or replace function public.delete_challenge(p_challenge_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  ch public.challenges;
  taken integer := 0;
  r record;
  applied integer;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into ch from public.challenges where id = p_challenge_id and household_id = hh for update;
  if not found then raise exception 'Challenge not found'; end if;

  if ch.status = 'completed' then
    taken := -public.pay_challenge(ch, -1, 'Challenge deleted: ' || ch.title, uid, 'deleted "' || ch.title || '"');
  elsif ch.status = 'expired_penalized' then
    for r in
      select profile_id, -sum(delta) as refund from public.point_ledger
      where reference_id = ch.id and reason like 'Missed deadline for challenge:%'
      group by profile_id
    loop
      if r.refund > 0 then
        applied := public.apply_points(r.profile_id, r.refund::integer, 'Penalty refunded (challenge deleted): ' || ch.title, ch.id);
        perform public.notify_points_adjusted(r.profile_id, uid, ch.id, 'deleted "' || ch.title || '" and refunded the penalty', applied);
        taken := taken - applied;
      end if;
    end loop;
  end if;

  delete from public.notifications
  where reference_id = ch.id
    and type in ('challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed', 'challenge_expired');
  delete from public.challenges where id = ch.id;

  return taken;
end $$;

-- ---------------------------------------------------------------------------
-- Settlement of deadlines
-- ---------------------------------------------------------------------------
create function public.settle_challenges_core(p_household uuid default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ch public.challenges;
  settled integer := 0;
  applied integer;
  m uuid;
begin
  for ch in
    select c.* from public.challenges c
    join public.households h on h.id = c.household_id
    where c.status in ('active', 'pending')
      and c.deadline_date is not null
      and c.deadline_date < (now() at time zone h.timezone)::date
      and (p_household is null or c.household_id = p_household)
    order by c.deadline_date, c.created_at
    for update of c skip locked
  loop
    if ch.status = 'pending' then
      -- Nobody accepted it in time: it just lapses.
      update public.challenges set status = 'expired' where id = ch.id;
      delete from public.notifications where reference_id = ch.id and type = 'challenge_proposed';

    elsif ch.type = 'forfeit' and ch.current_count < ch.target_count then
      -- Missed the deadline: dock the penalty (never below 0), log it, tell them.
      applied := -public.apply_points(
        ch.assigned_to, -ch.penalty_points, 'Missed deadline for challenge: ' || ch.title, ch.id, true
      );
      update public.challenges set status = 'expired_penalized' where id = ch.id;
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (
        ch.assigned_to, null, 'challenge_expired', ch.id,
        'Deadline passed: ' || ch.title || '. '
          || case when applied > 0 then applied || case when applied = 1 then ' point was' else ' points were' end || ' deducted.'
                  else 'Your balance was already 0, so nothing was deducted.' end
      );

    else
      -- A reward challenge that ran out of time: no penalty, it just ends.
      update public.challenges set status = 'expired' where id = ch.id;
      for m in
        select id from public.profiles where household_id = ch.household_id and (ch.is_joint or id = ch.assigned_to)
      loop
        insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
        values (m, null, 'challenge_expired', ch.id, 'Deadline passed: ' || ch.title || '. It was not finished in time.');
      end loop;
    end if;
    settled := settled + 1;
  end loop;
  return settled;
end $$;
revoke all on function public.settle_challenges_core(uuid) from public, anon, authenticated;

-- Called from the app whenever it opens, for the caller's household only.
create function public.settle_my_challenges() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  hh uuid := public.current_household_id();
begin
  if auth.uid() is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  return public.settle_challenges_core(hh);
end $$;
revoke all on function public.settle_my_challenges() from public, anon;
grant execute on function public.settle_my_challenges() to authenticated;

-- Hourly, so each household is settled shortly after ITS midnight whatever its timezone. Best effort: the
-- extension may not be enabled, and the app also settles whenever it is opened, so a failure here is a notice,
-- not an error.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('settle-expired-challenges', '5 * * * *', 'select public.settle_challenges_core(null)');
  else
    raise notice 'pg_cron is not available: forfeits will settle when the app is next opened';
  end if;
exception when others then
  raise notice 'Could not schedule the hourly settlement (%): forfeits will settle when the app is next opened', sqlerrm;
end $$;

-- Replaced by apply_points() everywhere (0011-0013).
drop function public.adjust_points(uuid, integer);
