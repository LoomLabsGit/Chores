-- The backlog: a shared list of jobs that need doing, to be picked up whenever there is free time.
--
-- A backlog job has a title, a priority (1 low, 2 medium, 3 high), an optional person it is for and the same
-- pricing as any chore (an estimated time plus chore tax, or a fixed bounty), so that when it is planned it
-- arrives on the calendar worth what it was logged as. It is not a library chore: it is a one-off job, so it
-- never shows up in Manage chores, and planning it MOVES it out of the backlog onto the calendar as an ordinary
-- one-off chore (chore_id null).
--
-- Both partners have the same access (as everywhere). The rules that matter live here, not just on screen:
--   * the household and the person it is for are checked by row security, so nothing can leak across households;
--   * who added it (created_by) is stamped by a trigger and cannot be written by a client;
--   * planning a job is one function (schedule_backlog_item) that adds the chore and removes the job in a single
--     transaction, so if both partners tap "plan" at once exactly one chore is created;
--   * assigning a job to the other person tells them (a 'backlog_assigned' notification).
--
-- Adds one table, two triggers, one function, one notification type. Run 0001-0015 first.

create table public.backlog_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  priority smallint not null default 2 check (priority between 1 and 3),
  assigned_to uuid references public.profiles(id) on delete set null,
  estimated_duration integer not null default 15
    check (estimated_duration between 5 and 1440 and estimated_duration % 5 = 0),
  chore_tax integer not null default 0 check (chore_tax between 0 and 50),
  pricing_type public.chore_pricing_type not null default 'time_based',
  fixed_bounty_points integer not null default 15 check (fixed_bounty_points between 1 and 500),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index backlog_items_household_idx on public.backlog_items (household_id, priority desc, created_at);

alter table public.backlog_items enable row level security;

create policy backlog_select on public.backlog_items for select to authenticated
  using (household_id = public.current_household_id());
create policy backlog_insert on public.backlog_items for insert to authenticated
  with check (
    household_id = public.current_household_id()
    and (assigned_to is null or public.is_household_member(assigned_to))
  );
create policy backlog_update on public.backlog_items for update to authenticated
  using (household_id = public.current_household_id())
  with check (
    household_id = public.current_household_id()
    and (assigned_to is null or public.is_household_member(assigned_to))
  );
create policy backlog_delete on public.backlog_items for delete to authenticated
  using (household_id = public.current_household_id());

revoke all on public.backlog_items from anon, authenticated;
grant select, delete on public.backlog_items to authenticated;
-- `id` is insertable so the app can show a new job straight away under a client-side uuid.
grant insert (id, household_id, title, priority, assigned_to, estimated_duration, chore_tax, pricing_type, fixed_bounty_points)
  on public.backlog_items to authenticated;
grant update (title, priority, assigned_to, estimated_duration, chore_tax, pricing_type, fixed_bounty_points)
  on public.backlog_items to authenticated;

-- Tidy the title, and record who added the job (a client cannot choose this).
create function public.backlog_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.title := btrim(new.title);
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end $$;

create trigger backlog_items_before_write
before insert or update on public.backlog_items
for each row execute function public.backlog_before_write();

-- ---------------------------------------------------------------------------
-- Tell the other person when a job is put on their plate
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'chore_assigned', 'chore_completed',
  'challenge_proposed', 'challenge_accepted', 'challenge_declined', 'challenge_completed',
  'reward_redeemed', 'points_adjusted', 'challenge_expired',
  'reward_proposed', 'reward_approved', 'reward_declined',
  'backlog_assigned'
));

create function public.notify_backlog_assigned() returns trigger
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
    new.assigned_to, auth.uid(), 'backlog_assigned', new.id,
    coalesce(actor_name, 'Someone') || ' gave you a backlog job: ' || new.title
  );
  return new;
end $$;

create trigger backlog_items_notify_assigned
after insert or update of assigned_to on public.backlog_items
for each row execute function public.notify_backlog_assigned();

-- ---------------------------------------------------------------------------
-- Plan a job: put it on the calendar and take it off the backlog, in one go
-- ---------------------------------------------------------------------------
-- Who it is for is always stated by the caller (null = nobody in particular), while time / tax / pricing default to what
-- the job was logged with and can be overridden for this one planning. A fixed bounty carries no chore tax.
create function public.schedule_backlog_item(
  p_item_id uuid,
  p_date date,
  p_assigned_to uuid,
  p_minutes integer default null,
  p_tax integer default null,
  p_pricing_type public.chore_pricing_type default null,
  p_bounty integer default null
) returns public.chore_instances
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  item public.backlog_items;
  pricing public.chore_pricing_type;
  inst public.chore_instances;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_date is null then raise exception 'Pick a day for it'; end if;

  -- Locking the row is what makes a double tap, or both partners at once, create a single chore.
  select * into item from public.backlog_items where id = p_item_id and household_id = hh for update;
  if not found then raise exception 'That job is no longer in the backlog'; end if;

  if p_assigned_to is not null and not public.is_household_member(p_assigned_to) then
    raise exception 'You can only give it to someone in your household';
  end if;

  pricing := coalesce(p_pricing_type, item.pricing_type);
  insert into public.chore_instances (
    household_id, title, assigned_to, scheduled_date,
    estimated_duration, chore_tax, pricing_type, fixed_bounty_points
  ) values (
    hh, item.title, p_assigned_to, p_date,
    coalesce(p_minutes, item.estimated_duration),
    case when pricing = 'fixed_bounty' then 0 else coalesce(p_tax, item.chore_tax) end,
    pricing,
    coalesce(p_bounty, item.fixed_bounty_points)
  ) returning * into inst;

  delete from public.backlog_items where id = item.id;
  return inst;
end $$;

revoke all on function public.schedule_backlog_item(uuid, date, uuid, integer, integer, public.chore_pricing_type, integer)
  from public, anon;
grant execute on function public.schedule_backlog_item(uuid, date, uuid, integer, integer, public.chore_pricing_type, integer)
  to authenticated;

-- Live across both devices.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.backlog_items;
  end if;
end $$;
