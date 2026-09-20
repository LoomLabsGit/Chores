-- The point ledger: an audit trail of every change to a balance.
--
-- Each row records who, how much (positive = earned, negative = penalised or spent), the balance AFTER it,
-- why, and what it relates to (a chore completion, a challenge or a reward). Rows are written only by the
-- server functions through public.apply_points(); clients can read their household's ledger but never write.
--
-- This migration adds the table and the helper, and moves the balance changes that the later migrations
-- do not rewrite (uncheck, delete a finished chore, redeem a reward) onto it. Chore completion, re-pricing
-- and challenges move in 0012 / 0013 as those functions are rewritten for fixed-bounty chores and
-- forfeit / joint challenges. Run 0001-0010 first.

create table public.point_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) not null,
  delta integer not null,                                  -- positive (earned) or negative (penalised / spent)
  balance_after integer not null check (balance_after >= 0),
  reason text not null,
  reference_id uuid,                                       -- completion, challenge or reward id (no FK: the row may be gone)
  created_at timestamptz default now(),                    -- now() is the transaction start, so rows in one transaction tie...
  seq bigint generated always as identity                  -- ...and seq gives every row an exact order
);
create index point_ledger_profile_idx on public.point_ledger (profile_id, seq desc);

alter table public.point_ledger enable row level security;
create policy point_ledger_select on public.point_ledger for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = point_ledger.profile_id and p.household_id = public.current_household_id()
  ));
revoke all on public.point_ledger from anon, authenticated;
grant select on public.point_ledger to authenticated;

-- Balances that already exist have no history, so start each chain with an opening row.
insert into public.point_ledger (profile_id, delta, balance_after, reason)
select id, points, points, 'Opening balance (before the ledger)' from public.profiles where points > 0;

-- ---------------------------------------------------------------------------
-- The one way to change a balance. Internal: only other SECURITY DEFINER functions call it.
-- Never takes a balance below 0 (profiles.points has CHECK >= 0). Returns the REAL change after that
-- floor, which is what is recorded. A zero change is only logged when p_log_zero is set (e.g. a penalty
-- that found an empty balance still deserves its line).
-- ---------------------------------------------------------------------------
create function public.apply_points(
  p_user uuid, p_delta integer, p_reason text, p_ref uuid, p_log_zero boolean default false
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  before_pts integer;
  after_pts integer;
begin
  select points into before_pts from public.profiles where id = p_user for update;
  if not found then raise exception 'Unknown person'; end if;

  after_pts := greatest(before_pts + p_delta, 0);
  if after_pts <> before_pts then
    update public.profiles set points = after_pts where id = p_user;
  end if;

  if after_pts <> before_pts or p_log_zero then
    insert into public.point_ledger (profile_id, delta, balance_after, reason, reference_id)
    values (p_user, after_pts - before_pts, after_pts, p_reason, p_ref);
  end if;
  return after_pts - before_pts;
end $$;

revoke all on function public.apply_points(uuid, integer, text, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Uncheck: takes back exactly what the completion paid out (body as 0004, now through the ledger).
-- ---------------------------------------------------------------------------
create or replace function public.uncomplete_chore(p_instance_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  comp public.chore_completions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if not inst.is_completed then raise exception 'That chore is not completed'; end if;

  select * into comp from public.chore_completions where instance_id = inst.id;
  if found then
    perform public.apply_points(comp.user_a_id, -comp.user_a_points, 'Chore unchecked: ' || inst.title, comp.id);
    if comp.user_b_id <> comp.user_a_id then
      perform public.apply_points(comp.user_b_id, -comp.user_b_points, 'Chore unchecked: ' || inst.title, comp.id);
    end if;
    delete from public.chore_completions where instance_id = inst.id;
  end if;

  update public.chore_instances
  set is_completed = false, completed_at = null
  where id = inst.id;

  delete from public.notifications where reference_id = inst.id and type = 'chore_completed';
end $$;

-- ---------------------------------------------------------------------------
-- Delete a finished chore: its points are taken back (body as 0002, now through the ledger).
-- ---------------------------------------------------------------------------
create or replace function public.remove_completed_chore(p_instance_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  comp public.chore_completions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;

  if inst.is_completed then
    select * into comp from public.chore_completions where instance_id = inst.id;
    if found then
      perform public.apply_points(comp.user_a_id, -comp.user_a_points, 'Chore deleted: ' || inst.title, comp.id);
      if comp.user_b_id <> comp.user_a_id then
        perform public.apply_points(comp.user_b_id, -comp.user_b_points, 'Chore deleted: ' || inst.title, comp.id);
      end if;
    end if;
  end if;

  delete from public.notifications where reference_id = inst.id and type in ('chore_assigned', 'chore_completed');
  delete from public.chore_instances where id = inst.id; -- chore_completions cascades
end $$;

-- ---------------------------------------------------------------------------
-- Redeem a reward (body as 0001, now through the ledger). The balance is locked while it is checked.
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
  where id = p_reward_id and household_id = hh and is_active;
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
