-- DuoSync initial schema.
--
-- Tables follow the functional spec. Additions beyond the spec DDL (each needed
-- to make the spec's behaviour work safely):
--   * public.households + invite_code   - how two partners end up in one household
--   * FKs from household_id columns     - referential integrity
--   * challenges.completed_at           - Stats needs to date challenge payouts
--   * notifications.type gains 'challenge_declined' and 'challenge_completed'
--   * chore_instances.points_assigned CHECK (1..10) - matches the library rule
--
-- Security model: clients can READ everything in their household, but points,
-- completion state, challenges and redemptions only change through the
-- SECURITY DEFINER functions at the bottom (atomic + server-validated).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  invite_code text not null unique
    default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)),
  created_at timestamptz default now()
);

create table public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  display_name text not null,
  avatar_url text,
  household_id uuid not null references public.households(id) on delete cascade,
  points integer default 0 check (points >= 0),
  is_admin boolean default false,
  created_at timestamptz default now()
);
create index profiles_household_idx on public.profiles (household_id);

create table public.chore_library (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  category text default 'General',
  default_duration integer default 15, -- in minutes
  default_points integer default 5 check (default_points between 1 and 10),
  is_archived boolean default false,
  last_used_at timestamptz default now(),
  created_at timestamptz default now()
);
create index chore_library_household_idx on public.chore_library (household_id);

create table public.chore_instances (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid references public.chore_library(id) on delete set null,
  title text not null, -- snapshot from library
  household_id uuid not null references public.households(id) on delete cascade,
  assigned_to uuid references public.profiles(id),
  scheduled_date date not null,
  is_completed boolean default false,
  completed_at timestamptz,
  is_recurring boolean default false,
  recurrence_rule text, -- e.g. "FREQ=WEEKLY;BYDAY=SA"
  parent_recurrence_id uuid, -- links recurring instances together
  points_assigned integer not null default 5 check (points_assigned between 1 and 10)
);
create index chore_instances_household_date_idx
  on public.chore_instances (household_id, scheduled_date);

create table public.chore_completions (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid references public.chore_instances(id) on delete cascade,
  total_duration_minutes integer not null default 0,
  user_a_id uuid references public.profiles(id) not null,
  user_a_duration integer not null default 0,
  user_a_points integer not null default 0,
  user_b_id uuid references public.profiles(id) not null,
  user_b_duration integer not null default 0,
  user_b_points integer not null default 0,
  created_at timestamptz default now()
);
create index chore_completions_instance_idx on public.chore_completions (instance_id);
create index chore_completions_created_idx on public.chore_completions (created_at);

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  creator_id uuid references public.profiles(id) not null,
  assigned_to uuid references public.profiles(id) not null,
  title text not null,
  target_count integer not null check (target_count > 0),
  current_count integer not null default 0 check (current_count <= target_count),
  reward_points integer not null default 20,
  status text default 'pending' check (status in ('pending', 'active', 'completed', 'rejected')),
  created_at timestamptz default now(),
  completed_at timestamptz
);
create index challenges_household_idx on public.challenges (household_id);

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text,
  cost integer not null check (cost > 0),
  is_active boolean default true,
  created_at timestamptz default now()
);
create index rewards_household_idx on public.rewards (household_id);

create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid references public.rewards(id),
  redeemed_by uuid references public.profiles(id) not null,
  cost integer not null,
  created_at timestamptz default now()
);
create index reward_redemptions_user_idx on public.reward_redemptions (redeemed_by, created_at);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid references public.profiles(id) not null,
  actor_id uuid references public.profiles(id),
  type text not null check (type in (
    'chore_assigned', 'chore_completed',
    'challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed',
    'reward_redeemed'
  )),
  reference_id uuid,
  message text not null,
  is_read boolean default false,
  created_at timestamptz default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Helpers used by RLS policies (SECURITY DEFINER avoids policy recursion)
-- ---------------------------------------------------------------------------

create function public.current_household_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select household_id from public.profiles where id = auth.uid()
$$;

create function public.is_household_member(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = p_user and household_id = public.current_household_id()
  )
$$;

create function public.is_household_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.chore_library enable row level security;
alter table public.chore_instances enable row level security;
alter table public.chore_completions enable row level security;
alter table public.challenges enable row level security;
alter table public.rewards enable row level security;
alter table public.reward_redemptions enable row level security;
alter table public.notifications enable row level security;

create policy households_select on public.households for select to authenticated
  using (id = public.current_household_id());

create policy profiles_select on public.profiles for select to authenticated
  using (household_id = public.current_household_id());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy library_select on public.chore_library for select to authenticated
  using (household_id = public.current_household_id());
create policy library_insert on public.chore_library for insert to authenticated
  with check (household_id = public.current_household_id());
create policy library_update on public.chore_library for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy instances_select on public.chore_instances for select to authenticated
  using (household_id = public.current_household_id());
create policy instances_insert on public.chore_instances for insert to authenticated
  with check (
    household_id = public.current_household_id()
    and (assigned_to is null or public.is_household_member(assigned_to))
    and (
      chore_id is null or exists (
        select 1 from public.chore_library l
        where l.id = chore_instances.chore_id
          and l.household_id = chore_instances.household_id
      )
    )
  );
-- Completed chores are history: no rescheduling / reassigning / deleting them.
create policy instances_update on public.chore_instances for update to authenticated
  using (household_id = public.current_household_id() and not is_completed)
  with check (
    household_id = public.current_household_id()
    and (assigned_to is null or public.is_household_member(assigned_to))
  );
create policy instances_delete on public.chore_instances for delete to authenticated
  using (household_id = public.current_household_id() and not is_completed);

create policy completions_select on public.chore_completions for select to authenticated
  using (
    exists (
      select 1 from public.chore_instances i
      where i.id = chore_completions.instance_id
        and i.household_id = public.current_household_id()
    )
  );

create policy challenges_select on public.challenges for select to authenticated
  using (household_id = public.current_household_id());

create policy rewards_select on public.rewards for select to authenticated
  using (household_id = public.current_household_id());
create policy rewards_insert on public.rewards for insert to authenticated
  with check (household_id = public.current_household_id() and public.is_household_admin());
create policy rewards_update on public.rewards for update to authenticated
  using (household_id = public.current_household_id() and public.is_household_admin())
  with check (household_id = public.current_household_id() and public.is_household_admin());

create policy redemptions_select on public.reward_redemptions for select to authenticated
  using (public.is_household_member(redeemed_by));

create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Table / column privileges. Supabase grants ALL on new tables to the API
-- roles by default, so revoke first and hand back only what the app needs.
-- Columns not listed (points, is_completed, ...) are writable only by the
-- SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------

revoke all on
  public.households, public.profiles, public.chore_library, public.chore_instances,
  public.chore_completions, public.challenges, public.rewards,
  public.reward_redemptions, public.notifications
from anon, authenticated;

grant select on
  public.households, public.profiles, public.chore_library, public.chore_instances,
  public.chore_completions, public.challenges, public.rewards,
  public.reward_redemptions, public.notifications
to authenticated;

grant update (display_name, avatar_url) on public.profiles to authenticated;

-- `id` is insertable so the UI can create rows optimistically with a client-side uuid.
grant insert (id, household_id, title, category, default_duration, default_points)
  on public.chore_library to authenticated;
grant update (title, category, default_duration, default_points, is_archived)
  on public.chore_library to authenticated;

grant insert (id, chore_id, title, household_id, assigned_to, scheduled_date,
              is_recurring, recurrence_rule, parent_recurrence_id, points_assigned)
  on public.chore_instances to authenticated;
grant update (title, assigned_to, scheduled_date) on public.chore_instances to authenticated;
grant delete on public.chore_instances to authenticated;

grant insert (id, household_id, title, description, cost) on public.rewards to authenticated;
grant update (title, description, cost, is_active) on public.rewards to authenticated;

grant update (is_read) on public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Tell a partner when a chore is assigned to them (create or drag-reassign).
create function public.notify_chore_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor_name text;
begin
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

create trigger chore_instances_notify_assigned
after insert or update of assigned_to on public.chore_instances
for each row execute function public.notify_chore_assigned();

-- Keeps "Recent tasks" in the Add Chore sheet fresh.
create function public.touch_chore_last_used() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.chore_id is not null then
    update public.chore_library set last_used_at = now() where id = new.chore_id;
  end if;
  return new;
end $$;

create trigger chore_instances_touch_library
after insert on public.chore_instances
for each row execute function public.touch_chore_last_used();

-- ---------------------------------------------------------------------------
-- Functions (RPC). All validate the caller server-side.
-- ---------------------------------------------------------------------------

create function public.create_household(p_display_name text, p_household_name text default null)
returns public.households
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh public.households;
begin
  if uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles where id = uid) then
    raise exception 'You already belong to a household';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'Please enter your name';
  end if;

  insert into public.households (name)
  values (coalesce(nullif(trim(p_household_name), ''), 'Our household'))
  returning * into hh;

  insert into public.profiles (id, display_name, household_id, is_admin)
  values (uid, trim(p_display_name), hh.id, true);

  -- The six pre-baked chores. last_used_at stays null so "Recent" only shows
  -- chores that have genuinely been scheduled.
  insert into public.chore_library (household_id, title, category, default_duration, default_points, last_used_at)
  values
    (hh.id, 'Washing up',      'Kitchen',  20, 3, null),
    (hh.id, 'Hoovering',       'Cleaning', 25, 8, null),
    (hh.id, 'Cooking dinner',  'Kitchen',  45, 6, null),
    (hh.id, 'Watering plants', 'Garden',   10, 2, null),
    (hh.id, 'Dirty laundry',   'Laundry',  10, 4, null),
    (hh.id, 'Hanging laundry', 'Laundry',  15, 5, null);

  insert into public.rewards (household_id, title, description, cost)
  values
    (hh.id, '10 min massage',       'Shoulders, back, your choice',      50),
    (hh.id, 'Pick the film',        'Your choice tonight, no vetoes',    30),
    (hh.id, 'Breakfast in bed',     'Served with a smile',               75),
    (hh.id, 'Skip one chore',       'A free pass on any single chore',   40);

  return hh;
end $$;

create function public.join_household(p_display_name text, p_invite_code text)
returns public.households
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh public.households;
begin
  if uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles where id = uid) then
    raise exception 'You already belong to a household';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'Please enter your name';
  end if;

  select * into hh from public.households
  where invite_code = upper(trim(p_invite_code));
  if not found then raise exception 'That invite code was not found'; end if;

  if (select count(*) from public.profiles where household_id = hh.id) >= 2 then
    raise exception 'That household already has two members';
  end if;

  insert into public.profiles (id, display_name, household_id, is_admin)
  values (uid, trim(p_display_name), hh.id, false);

  return hh;
end $$;

-- Logs a completion, splits minutes + points, credits balances, notifies partner.
-- p_my_percent is the caller's share (0..100 in steps of 10). Shares use
-- round(total * pct / 100), so odd totals can differ from the entered total by
-- a point/minute - that is the spec's rounding rule.
create function public.complete_chore(
  p_instance_id uuid, p_total_minutes integer, p_my_percent integer default 100
) returns public.chore_completions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  partner uuid;
  my_name text;
  my_min int; my_pts int; pt_min int; pt_pts int;
  result public.chore_completions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_total_minutes is null or p_total_minutes < 0 or p_total_minutes > 1440 then
    raise exception 'Duration must be between 0 and 1440 minutes';
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

  my_min  := round(p_total_minutes * p_my_percent / 100.0);
  pt_min  := round(p_total_minutes * (100 - p_my_percent) / 100.0);
  my_pts  := round(inst.points_assigned * p_my_percent / 100.0);
  pt_pts  := round(inst.points_assigned * (100 - p_my_percent) / 100.0);

  insert into public.chore_completions (
    instance_id, total_duration_minutes,
    user_a_id, user_a_duration, user_a_points,
    user_b_id, user_b_duration, user_b_points
  ) values (
    inst.id, p_total_minutes, uid, my_min, my_pts, partner, pt_min, pt_pts
  ) returning * into result;

  update public.chore_instances
  set is_completed = true, completed_at = now()
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

create function public.create_challenge(
  p_title text, p_assigned_to uuid, p_target_count integer, p_reward_points integer
) returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  my_name text;
  result public.challenges;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the challenge a name'; end if;
  if p_target_count is null or p_target_count < 1 or p_target_count > 1000 then
    raise exception 'Target must be between 1 and 1000';
  end if;
  if p_reward_points is null or p_reward_points < 1 or p_reward_points > 500 then
    raise exception 'Reward must be between 1 and 500 points';
  end if;
  if not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;

  insert into public.challenges (
    household_id, creator_id, assigned_to, title, target_count, reward_points, status
  ) values (
    hh, uid, p_assigned_to, trim(p_title), p_target_count, p_reward_points,
    case when p_assigned_to = uid then 'active' else 'pending' end
  ) returning * into result;

  if p_assigned_to <> uid then
    select display_name into my_name from public.profiles where id = uid;
    insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
    values (
      p_assigned_to, uid, 'challenge_proposed', result.id,
      my_name || ' set a challenge for you: ' || result.title
    );
  end if;

  return result;
end $$;

create function public.respond_to_challenge(p_challenge_id uuid, p_accept boolean)
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

-- +1 progress. Hitting the target completes the challenge and pays the assignee.
create function public.increment_challenge(p_challenge_id uuid)
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
  where id = p_challenge_id and household_id = hh and assigned_to = uid and status = 'active'
  for update;
  if not found then raise exception 'That challenge is not active for you'; end if;

  if result.current_count + 1 >= result.target_count then
    update public.challenges
    set current_count = target_count, status = 'completed', completed_at = now()
    where id = result.id
    returning * into result;

    update public.profiles set points = points + result.reward_points where id = uid;

    if result.creator_id <> uid then
      select display_name into my_name from public.profiles where id = uid;
      insert into public.notifications (recipient_id, actor_id, type, reference_id, message)
      values (
        result.creator_id, uid, 'challenge_completed', result.id,
        my_name || ' completed your challenge: ' || result.title
      );
    end if;
  else
    update public.challenges set current_count = current_count + 1
    where id = result.id
    returning * into result;
  end if;

  return result;
end $$;

create function public.redeem_reward(p_reward_id uuid)
returns public.reward_redemptions
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  reward public.rewards;
  my_name text;
  partner uuid;
  result public.reward_redemptions;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into reward from public.rewards
  where id = p_reward_id and household_id = hh and is_active;
  if not found then raise exception 'That reward is no longer available'; end if;

  update public.profiles set points = points - reward.cost
  where id = uid and points >= reward.cost;
  if not found then raise exception 'Not enough points for that reward'; end if;

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

-- Lock the RPCs down to signed-in users (Supabase grants EXECUTE to anon by default).
revoke all on function
  public.create_household(text, text),
  public.join_household(text, text),
  public.complete_chore(uuid, integer, integer),
  public.create_challenge(text, uuid, integer, integer),
  public.respond_to_challenge(uuid, boolean),
  public.increment_challenge(uuid),
  public.redeem_reward(uuid),
  public.current_household_id(),
  public.is_household_member(uuid),
  public.is_household_admin()
from public, anon;

grant execute on function
  public.create_household(text, text),
  public.join_household(text, text),
  public.complete_chore(uuid, integer, integer),
  public.create_challenge(text, uuid, integer, integer),
  public.respond_to_challenge(uuid, boolean),
  public.increment_challenge(uuid),
  public.redeem_reward(uuid),
  public.current_household_id(),
  public.is_household_member(uuid),
  public.is_household_admin()
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: live points, task checks and notifications across both devices.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.profiles, public.chore_library, public.chore_instances,
      public.challenges, public.rewards, public.reward_redemptions,
      public.notifications;
  end if;
end $$;
