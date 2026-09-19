-- Lets a household member delete a chore, including one that is already completed.
--
-- Completed chores are protected from direct deletes (see instances_delete in 0001),
-- because deleting one would silently leave the points it paid out behind. This
-- function is the sanctioned way: it reverses the points, then deletes the chore,
-- its completion record and the notifications that pointed at it.
--
-- If someone has already spent the points, their balance is floored at 0 rather than
-- going negative (profiles.points has a CHECK >= 0).

create function public.remove_completed_chore(p_instance_id uuid)
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
      update public.profiles set points = greatest(points - comp.user_a_points, 0) where id = comp.user_a_id;
      if comp.user_b_id <> comp.user_a_id then
        update public.profiles set points = greatest(points - comp.user_b_points, 0) where id = comp.user_b_id;
      end if;
    end if;
  end if;

  delete from public.notifications where reference_id = inst.id and type in ('chore_assigned', 'chore_completed');
  delete from public.chore_instances where id = inst.id; -- chore_completions cascades
end $$;

revoke all on function public.remove_completed_chore(uuid) from public, anon;
grant execute on function public.remove_completed_chore(uuid) to authenticated;
