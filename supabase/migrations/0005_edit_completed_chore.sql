-- Edit a chore that is already completed: name, day and assignee only.
--
-- Points and logged time were already paid out and recorded, so they are deliberately not
-- editable here (to change them: uncheck the chore, edit it, complete it again).
-- Direct client updates of completed chores stay blocked by RLS; this function is the only way.
--
-- Additive: creates one new function. Run 0001-0004 first.

create function public.edit_completed_chore(
  p_instance_id uuid, p_title text, p_assigned_to uuid, p_scheduled_date date
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  inst public.chore_instances;
  new_title text := trim(p_title);
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if coalesce(new_title, '') = '' then raise exception 'Give the chore a name'; end if;
  if p_scheduled_date is null then raise exception 'Choose a day'; end if;
  if p_assigned_to is not null and not public.is_household_member(p_assigned_to) then
    raise exception 'Assignee is not in your household';
  end if;

  select * into inst from public.chore_instances
  where id = p_instance_id and household_id = hh
  for update;
  if not found then raise exception 'Chore not found'; end if;
  if not inst.is_completed then raise exception 'Use the normal edit for a chore that is not completed yet'; end if;

  -- Correcting a finished chore must not ping the partner as if it were a new assignment.
  perform set_config('duosync.skip_assign_notify', 'on', true);

  update public.chore_instances
  set title = new_title, assigned_to = p_assigned_to, scheduled_date = p_scheduled_date
  where id = inst.id;
end $$;

revoke all on function public.edit_completed_chore(uuid, text, uuid, date) from public, anon;
grant execute on function public.edit_completed_chore(uuid, text, uuid, date) to authenticated;
