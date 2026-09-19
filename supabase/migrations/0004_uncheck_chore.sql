-- "Uncheck": undo a completion without deleting the chore.
--
-- Takes back exactly the points the completion paid out (both partners' shares), deletes
-- the completion record and the "X completed ..." notification, and returns the chore to
-- unfinished so it can be edited, moved or completed again. If someone already spent the
-- points, their balance is floored at 0 (profiles.points has a CHECK >= 0).
--
-- Additive: creates one new function. Run 0001-0003 first.

create function public.uncomplete_chore(p_instance_id uuid)
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
    update public.profiles set points = greatest(points - comp.user_a_points, 0) where id = comp.user_a_id;
    if comp.user_b_id <> comp.user_a_id then
      update public.profiles set points = greatest(points - comp.user_b_points, 0) where id = comp.user_b_id;
    end if;
    delete from public.chore_completions where instance_id = inst.id;
  end if;

  update public.chore_instances
  set is_completed = false, completed_at = null
  where id = inst.id;

  delete from public.notifications where reference_id = inst.id and type = 'chore_completed';
end $$;

revoke all on function public.uncomplete_chore(uuid) from public, anon;
grant execute on function public.uncomplete_chore(uuid) to authenticated;
