-- New rewards have to be signed off by the other person.
--
-- A reward added to the shop starts as 'pending'. Nobody can redeem it until the OTHER partner approves it,
-- and the person who suggested it cannot approve their own. The other partner can also decline it (the
-- suggester then sees it as declined and can remove it). Rewards that exist today stay approved.
--
-- The rule lives in the database, not just the screen:
--   * a BEFORE INSERT trigger stamps the reward with who added it and forces 'pending' whatever the client
--     sent, so an out-of-date copy of the app cannot add a reward that skips the sign-off;
--   * clients can no longer write status / created_by / approved_by, and can no longer edit a reward's title,
--     description or cost after the fact (that would bypass the sign-off too). They can still retire one;
--   * redeem_reward() only redeems approved rewards.
-- If there is no partner yet there is nobody to ask, so the reward is approved straight away.
--
-- Adds columns, one trigger, one function; replaces redeem_reward and tightens two grants.
-- Run 0001-0014 first.

alter table public.rewards
  add column status text not null default 'approved' check (status in ('pending', 'approved', 'declined')),
  add column created_by uuid references public.profiles(id),
  add column approved_by uuid references public.profiles(id),
  add column approved_at timestamptz;

update public.rewards set approved_at = created_at where status = 'approved';

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'chore_assigned', 'chore_completed',
  'challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed',
  'reward_redeemed', 'points_adjusted', 'challenge_expired',
  'reward_proposed', 'reward_approved', 'reward_declined'
));

-- ---------------------------------------------------------------------------
-- Adding a reward: force it through the sign-off, whatever the client sent
-- ---------------------------------------------------------------------------
create function public.rewards_require_signoff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  partner uuid;
begin
  -- Trusted server-side inserts (no signed-in user) say for themselves what status they want.
  if uid is null then return new; end if;

  new.created_by := uid;
  new.approved_by := null;
  select id into partner from public.profiles where household_id = new.household_id and id <> uid limit 1;
  if partner is null then
    new.status := 'approved'; -- nobody else to ask
    new.approved_at := now();
  else
    new.status := 'pending';
    new.approved_at := null;
  end if;
  return new;
end $$;

create trigger rewards_signoff_before_insert
before insert on public.rewards
for each row execute function public.rewards_require_signoff();

-- Tell the other person there is something to sign off.
create function public.rewards_notify_signoff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  partner uuid;
  actor_name text;
begin
  if new.status <> 'pending' or new.created_by is null then return new; end if;
  select id into partner from public.profiles where household_id = new.household_id and id <> new.created_by limit 1;
  if partner is null then return new; end if;
  select display_name into actor_name from public.profiles where id = new.created_by;
  insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
  values (
    partner, new.created_by, 'reward_proposed', new.id,
    actor_name || ' suggested a reward: ' || new.title || ' (' || new.cost || ' pts). It needs your sign-off'
  );
  return new;
end $$;

create trigger rewards_signoff_after_insert
after insert on public.rewards
for each row execute function public.rewards_notify_signoff();

-- What a client may still change on a reward: only whether it is retired.
revoke update (title, description, cost) on public.rewards from authenticated;

-- ---------------------------------------------------------------------------
-- The other person's answer
-- ---------------------------------------------------------------------------
create function public.respond_to_reward(p_reward_id uuid, p_approve boolean)
returns public.rewards
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  r public.rewards;
  my_name text;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into r from public.rewards where id = p_reward_id and household_id = hh and is_active for update;
  if not found then raise exception 'Reward not found'; end if;
  if r.status <> 'pending' then raise exception 'That reward has already been answered'; end if;
  if r.created_by is not distinct from uid then
    raise exception 'The other person has to sign off your reward, not you';
  end if;

  update public.rewards
  set status = case when p_approve then 'approved' else 'declined' end,
      approved_by = case when p_approve then uid end,
      approved_at = case when p_approve then now() end
  where id = r.id
  returning * into r;

  update public.notifications set is_read = true
  where recipient_id = uid and type = 'reward_proposed' and reference_id = r.id;

  if r.created_by is not null and r.created_by <> uid then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      r.created_by, uid,
      case when p_approve then 'reward_approved' else 'reward_declined' end,
      r.id,
      my_name || case when p_approve then ' approved your reward: ' else ' declined your reward: ' end || r.title
    );
  end if;

  return r;
end $$;

revoke all on function public.respond_to_reward(uuid, boolean) from public, anon;
grant execute on function public.respond_to_reward(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Redeeming: only approved rewards (body as 0011)
-- ---------------------------------------------------------------------------
create or replace function public.redeem_reward(p_reward_id uuid)
returns public.reward_redemptions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  reward public.rewards;
  balance integer;
  my_name text;
  partner uuid;
  result public.reward_redemptions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into reward from public.rewards
  where id = p_reward_id and household_id = hh and is_active and status = 'approved';
  if not found then raise exception 'That reward is no longer available'; end if;

  select points into balance from public.profiles where id = uid for update;
  if balance < reward.cost then raise exception 'Not enough points for that reward'; end if;
  perform public.apply_points(uid, -reward.cost, 'Reward redeemed: ' || reward.title, reward.id);

  insert into public.reward_redemptions (reward_id, redeemed_by, cost)
  values (reward.id, uid, reward.cost)
  returning * into result;

  select id into partner from public.profiles where household_id = hh and id <> uid limit 1;
  if partner is not null then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (partner, uid, 'reward_redeemed', result.id, my_name || ' redeemed: ' || reward.title);
  end if;

  return result;
end $$;
